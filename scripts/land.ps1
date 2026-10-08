<#
.SYNOPSIS
  Land an agent-made branch on main: re-sign, gate once, fast-forward, push,
  and optionally deploy or publish. Stops at the first problem.

.DESCRIPTION
  Agent sessions sign commits with their own key, which SIGNING_KEYS does not
  list, so CI rejects them until the founder re-signs. Re-signing only changes
  signatures, never content, so each commit is re-signed with --no-verify and
  the full gate runs ONCE on the final tree instead of once per commit (a
  per-commit gate re-runs old test files, and any network-dependent test in an
  old commit can fail at random). Founder ruling, 2026-10-07.

  Works from any of the repos: it detects what to gate and how to deploy.

.EXAMPLE
  .\scripts\land.ps1 -Branch claude/mint-claim-mcp-key -Deploy
.EXAMPLE
  ..\headless-oracle-v5\scripts\land.ps1 -Branch claude/web-mcp-api-key -Deploy
.EXAMPLE
  ..\headless-oracle-v5\scripts\land.ps1 -Branch claude/witness-v0.5 -Publish
.EXAMPLE
  ..\headless-oracle-v5\scripts\land.ps1 -Branch claude/ho-receipt-adapter -Base master

  If Windows refuses to run scripts:
    powershell -ExecutionPolicy Bypass -File .\scripts\land.ps1 -Branch <branch> -Deploy
#>
param(
  [Parameter(Mandatory = $true)][string]$Branch,
  [string]$Base = 'main',
  [switch]$Deploy,
  [switch]$Publish,
  [switch]$KeepBranch
)

# Continue, not Stop: every native call below is checked through its exit code.
# Under Windows PowerShell 5.1, Stop turns any stderr line of a redirected
# native command (wrangler prints warnings there) into a fatal error.
$ErrorActionPreference = 'Continue'

function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host ""; Write-Host "STOPPED: $text" -ForegroundColor Red; exit 1 }
function Invoke-Git {
  & git @args
  if ($LASTEXITCODE -ne 0) { Fail "git $($args -join ' ') failed (exit $LASTEXITCODE). Nothing after this step ran." }
}
# npm.cmd, not npm: on Windows `npm` resolves to the npm.ps1 shim, which
# re-reads its arguments from the text of the calling line, so `& npm @args`
# reached npm as the literal word "@args" (2026-10-08: smoke never ran).
$NpmExe = 'npm'
$NpxExe = 'npx'
if ($env:OS -eq 'Windows_NT') { $NpmExe = 'npm.cmd'; $NpxExe = 'npx.cmd' }
function Invoke-Npm {
  & $NpmExe @args
  if ($LASTEXITCODE -ne 0) { Fail "npm $($args -join ' ') failed (exit $LASTEXITCODE)." }
}
function GitBash {
  # Git for Windows' own bash, located from git itself. Never `Get-Command bash`:
  # on many Windows machines that is C:\Windows\System32\bash.exe (WSL), a
  # different Linux environment with its own curl, node and terminal (found
  # 2026-10-08: the smoke step could not reach the worker it had just started).
  $exec = (& git --exec-path) 2>$null
  if (-not $exec) { return $null }
  $root = Resolve-Path (Join-Path $exec '..\..\..') -ErrorAction SilentlyContinue
  if (-not $root) { return $null }
  $b = Join-Path $root 'bin\bash.exe'
  if (Test-Path $b) { return $b }
  return $null
}

# ---- 0. Preconditions --------------------------------------------------------
if (-not (Test-Path .git)) { Fail "run this from the root of a git repository." }
if ((Test-Path .git\rebase-merge) -or (Test-Path .git\rebase-apply)) {
  Fail "a rebase is already in progress here. Finish it (git rebase --continue) or cancel it (git rebase --abort), then run this again."
}
$dirty = & git status --porcelain --untracked-files=no
if ($dirty) { Fail "tracked files have uncommitted changes. Commit or stash them first:`n$dirty" }

if ($Publish) {
  # Checked before anything is merged or pushed: a publish that fails after the
  # push leaves the branch deleted and the package unpublished (2026-10-08,
  # chirindo 0.5.0 landed on main, then stopped at `npm whoami`).
  & $NpmExe whoami | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "not logged in to npm. Run npm login, then this again. Nothing was changed." }
}

$repo = Split-Path -Leaf (Get-Location)
Step "Landing $Branch onto $Base in $repo"

# ---- 1. Fetch and take the branch -------------------------------------------
Step "Fetching"
Invoke-Git fetch origin
& git rev-parse --verify --quiet "origin/$Branch" | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "origin/$Branch does not exist. Check the branch name." }
Invoke-Git checkout -B land "origin/$Branch"

# ---- 2. Re-sign every commit not yet on the base -----------------------------
Step "Re-signing commits (signature only; content unchanged)"
Invoke-Git rebase --exec "git commit --amend --no-edit -S --no-verify" "origin/$Base"

$lines = @(& git log --format="%G? %h %s" "origin/$Base..HEAD")
if ($lines.Count -eq 0) { Fail "nothing to land: $Branch has no commits that $Base lacks." }
$lines | ForEach-Object { Write-Host "   $_" }
$bad = @($lines | Where-Object { -not $_.StartsWith('G ') })
if ($bad.Count -gt 0) { Fail "$($bad.Count) commit(s) are not signed with your key (see lines above without G). Check your git signing setup." }

# ---- 3. One gate on the final tree ------------------------------------------
Step "Gate on the final tree"
if (Test-Path .githooks\pre-commit) {
  # Run the hook the way `git commit` runs it (git's own shell, no terminal on
  # stdin), so the gate behaves exactly as it does on a normal commit.
  $ver = [regex]::Match((& git --version), '(\d+)\.(\d+)')
  $hasHookRun = ([int]$ver.Groups[1].Value -gt 2) -or (([int]$ver.Groups[1].Value -eq 2) -and ([int]$ver.Groups[2].Value -ge 36))
  if ($hasHookRun) {
    & git -c core.hooksPath=.githooks hook run pre-commit
  } else {
    $bash = GitBash
    if (-not $bash) { Fail "git is older than 2.36 and Git for Windows' bash was not found. Update Git for Windows." }
    $null | & $bash .githooks/pre-commit
  }
  if ($LASTEXITCODE -ne 0) { Fail "the gate failed on the final tree. Nothing was merged or pushed." }
} else {
  $pkg = Get-Content package.json -Raw | ConvertFrom-Json
  Invoke-Npm ci
  if ($pkg.scripts.PSObject.Properties.Name -contains 'typecheck') { Invoke-Npm run typecheck }
  if ($pkg.scripts.PSObject.Properties.Name -contains 'test') { Invoke-Npm test }
  if ($pkg.scripts.PSObject.Properties.Name -contains 'build') { Invoke-Npm run build }
}

# ---- 4. Fast-forward the base and push --------------------------------------
Step "Fast-forwarding $Base and pushing"
Invoke-Git checkout $Base
Invoke-Git pull --ff-only origin $Base
Invoke-Git merge --ff-only land
Invoke-Git push origin $Base
Invoke-Git branch -D land
if (-not $KeepBranch) {
  & git push origin --delete $Branch
  if ($LASTEXITCODE -ne 0) { Write-Host "   (could not delete origin/$Branch; delete it on GitHub if you like)" -ForegroundColor Yellow }
}

# ---- 5. Deploy (worker or website) ------------------------------------------
if ($Deploy) {
  if ((Test-Path wrangler.toml) -and (Test-Path src\index.ts)) {
    Step "Deploying the worker"
    & $NpxExe wrangler whoami
    $log = Join-Path $env:TEMP "land-deploy-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss')).log"
    & $NpmExe run deploy 2>&1 | Tee-Object -FilePath $log
    $code = $LASTEXITCODE
    $text = Get-Content $log -Raw
    if ($code -ne 0) {
      if (($text -match 'Uploaded headless-oracle-v5') -and ($text -match '/workers/routes')) {
        Write-Host "   Upload succeeded; the error after it is the known B-115 route-listing failure (token lacks Workers Routes). Benign while routes are unchanged." -ForegroundColor Yellow
      } else {
        Fail "deploy failed (log: $log)."
      }
    }
    Step "Production smoke tests"
    Invoke-Npm run test:smoke
    Step "Live version"
    & $NpxExe wrangler deployments list | Select-Object -Last 6
  } elseif (Test-Path package.json) {
    Step "Deploying the website"
    Invoke-Npm run deploy
  } else {
    Fail "-Deploy given but this repo has nothing to deploy."
  }
}

# ---- 6. Publish (npm package) ------------------------------------------------
if ($Publish) {
  Step "Publishing to npm"
  if (Test-Path scripts\release-gate.mjs) {
    & node scripts/release-gate.mjs
    if ($LASTEXITCODE -ne 0) { Fail "release gate failed; nothing published." }
  }
  & $NpmExe whoami
  if ($LASTEXITCODE -ne 0) { Fail "not logged in to npm (run npm login)." }
  Invoke-Npm publish
  $name = (Get-Content package.json -Raw | ConvertFrom-Json).name
  & $NpmExe view $name version
}

Write-Host ""
Write-Host "DONE: $Branch is on $Base." -ForegroundColor Green

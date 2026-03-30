"""
Insert /v5/card/:mic endpoint into src/index.ts.

The card endpoint returns a live SVG "terminal card" showing the current
market state — suitable for embedding in GitHub READMEs as a dynamic demo
that requires no recording or screenshot.
"""
import re

SRC = 'src/index.ts'

with open(SRC, 'r', encoding='utf-8') as f:
    content = f.read()

# ── The route handler to insert ───────────────────────────────────────────────
# Inserted BEFORE the /badge/:mic handler (line ~8805)

CARD_ROUTE = r"""
		// ── GET /v5/card/:mic — Live SVG status card for GitHub README embedding ─
		// Returns a terminal-style SVG card with the current market status baked in.
		// Dynamic: fetches a live demo receipt on every request. No recording needed.
		// Use in README: <img src="https://api.headlessoracle.com/v5/card/XNYS" />
		// Cache-Control: no-cache so GitHub's CDN revalidates frequently.
		const cardMatch = url.pathname.match(/^\/v5\/card\/([A-Z0-9]+)$/);
		if (cardMatch) {
			const cardMic = cardMatch[1];
			if (!MARKET_CONFIGS[cardMic]) {
				return json({ error: 'INVALID_MIC', message: `Unknown exchange: ${cardMic}. See /v5/exchanges.` }, 404);
			}
			const cardReceipt = await buildSignedReceipt(cardMic, env, ctx, 'demo');
			const cardSvg = generateStatusCard(cardMic, cardReceipt as Record<string, string>);
			return new Response(cardSvg, {
				headers: {
					...corsHeaders,
					'Content-Type':     'image/svg+xml',
					'X-Oracle-Version': 'v5',
					'Cache-Control':    'no-cache, max-age=0',
				},
			});
		}

"""

# ── The generateStatusCard function ──────────────────────────────────────────
# Inserted BEFORE the /badge/:mic handler comment block

CARD_FUNCTION = r"""
// ── generateStatusCard — live terminal-style SVG card ────────────────────────
// Designed for GitHub README embedding. Uses only inline SVG (no external
// fonts, no JS) so it renders correctly in GitHub's camo CDN proxy.
function generateStatusCard(mic: string, receipt: Record<string, string>): string {
	const status = receipt.status || 'UNKNOWN';
	const statusColors: Record<string, string> = {
		OPEN:    '#22c55e',
		CLOSED:  '#6b7280',
		HALTED:  '#ef4444',
		UNKNOWN: '#f59e0b',
	};
	const bgColors: Record<string, string> = {
		OPEN:    '#0a1a0f',
		CLOSED:  '#0d1117',
		HALTED:  '#1a0808',
		UNKNOWN: '#191208',
	};
	const statusColor = statusColors[status] ?? '#6b7280';
	const bgColor     = bgColors[status]     ?? '#0d1117';

	const issuedAt   = receipt.issued_at   || '';
	const expiresAt  = receipt.expires_at  || '';
	const receiptId  = (receipt.receipt_id || '').slice(0, 8) + '…';
	const sig        = (receipt.signature  || '').slice(0, 24) + '…';
	const mode       = receipt.receipt_mode || 'demo';
	const issuer     = receipt.issuer || 'headlessoracle.com';

	// XML-escape dynamic values
	const x = (s: string) =>
		s.replace(/&/g, '&amp;')
		 .replace(/</g, '&lt;')
		 .replace(/>/g, '&gt;')
		 .replace(/"/g, '&quot;');

	return `<svg width="600" height="340" viewBox="0 0 600 340" xmlns="http://www.w3.org/2000/svg">
  <!-- Background -->
  <rect width="600" height="340" rx="8" fill="${bgColor}"/>
  <!-- Chrome bar -->
  <rect width="600" height="40" rx="8" fill="#161b22"/>
  <rect y="32" width="600" height="8" fill="#161b22"/>
  <!-- Traffic lights -->
  <circle cx="22" cy="20" r="6" fill="#ff5f57"/>
  <circle cx="42" cy="20" r="6" fill="#ffbd2e"/>
  <circle cx="62" cy="20" r="6" fill="#28c840"/>
  <!-- Title -->
  <text x="300" y="25" text-anchor="middle" font-family="'Courier New',Courier,monospace" font-size="12" fill="#8b949e">headless oracle · ${x(mic)} · <tspan fill="${statusColor}">${x(status)}</tspan></text>
  <!-- Divider -->
  <line x1="0" y1="40" x2="600" y2="40" stroke="#21262d" stroke-width="1"/>

  <!-- Prompt line -->
  <text x="20" y="66" font-family="'Courier New',Courier,monospace" font-size="12" fill="#4a5568">$</text>
  <text x="32" y="66" font-family="'Courier New',Courier,monospace" font-size="12" fill="#8b949e"> curl &quot;https://api.headlessoracle.com/v5/demo?mic=${x(mic)}&quot;</text>

  <!-- JSON open brace -->
  <text x="20" y="92" font-family="'Courier New',Courier,monospace" font-size="12" fill="#e6edf3">{</text>

  <!-- "mic" field -->
  <text x="20" y="114" font-family="'Courier New',Courier,monospace" font-size="12">
    <tspan fill="#e6edf3">  &quot;</tspan><tspan fill="#79c0ff">mic</tspan><tspan fill="#e6edf3">&quot;:          &quot;</tspan><tspan fill="#a5d6ff">${x(mic)}</tspan><tspan fill="#e6edf3">&quot;,</tspan>
  </text>

  <!-- "status" field — colored by current state -->
  <text x="20" y="136" font-family="'Courier New',Courier,monospace" font-size="12">
    <tspan fill="#e6edf3">  &quot;</tspan><tspan fill="#79c0ff">status</tspan><tspan fill="#e6edf3">&quot;:       &quot;</tspan><tspan fill="${statusColor}" font-weight="700">${x(status)}</tspan><tspan fill="#e6edf3">&quot;,</tspan>
  </text>

  <!-- "issued_at" field -->
  <text x="20" y="158" font-family="'Courier New',Courier,monospace" font-size="12">
    <tspan fill="#e6edf3">  &quot;</tspan><tspan fill="#79c0ff">issued_at</tspan><tspan fill="#e6edf3">&quot;:    &quot;</tspan><tspan fill="#a5d6ff">${x(issuedAt)}</tspan><tspan fill="#e6edf3">&quot;,</tspan>
  </text>

  <!-- "expires_at" field -->
  <text x="20" y="180" font-family="'Courier New',Courier,monospace" font-size="12">
    <tspan fill="#e6edf3">  &quot;</tspan><tspan fill="#79c0ff">expires_at</tspan><tspan fill="#e6edf3">&quot;:   &quot;</tspan><tspan fill="#a5d6ff">${x(expiresAt)}</tspan><tspan fill="#e6edf3">&quot;,</tspan>
  </text>

  <!-- "receipt_mode" field -->
  <text x="20" y="202" font-family="'Courier New',Courier,monospace" font-size="12">
    <tspan fill="#e6edf3">  &quot;</tspan><tspan fill="#79c0ff">receipt_mode</tspan><tspan fill="#e6edf3">&quot;: &quot;</tspan><tspan fill="#a5d6ff">${x(mode)}</tspan><tspan fill="#e6edf3">&quot;,</tspan>
  </text>

  <!-- "receipt_id" field -->
  <text x="20" y="224" font-family="'Courier New',Courier,monospace" font-size="12">
    <tspan fill="#e6edf3">  &quot;</tspan><tspan fill="#79c0ff">receipt_id</tspan><tspan fill="#e6edf3">&quot;:   &quot;</tspan><tspan fill="#a5d6ff">${x(receiptId)}</tspan><tspan fill="#e6edf3">&quot;,</tspan>
  </text>

  <!-- "signature" field -->
  <text x="20" y="246" font-family="'Courier New',Courier,monospace" font-size="12">
    <tspan fill="#e6edf3">  &quot;</tspan><tspan fill="#79c0ff">signature</tspan><tspan fill="#e6edf3">&quot;:    &quot;</tspan><tspan fill="#a5d6ff">${x(sig)}</tspan><tspan fill="#e6edf3">&quot;</tspan>
  </text>

  <!-- JSON close brace -->
  <text x="20" y="268" font-family="'Courier New',Courier,monospace" font-size="12" fill="#e6edf3">}</text>

  <!-- Footer divider -->
  <line x1="20" y1="283" x2="580" y2="283" stroke="#21262d" stroke-width="1"/>

  <!-- Footer text -->
  <text x="20" y="303" font-family="'Courier New',Courier,monospace" font-size="11" fill="#22c55e">✓</text>
  <text x="32" y="303" font-family="'Courier New',Courier,monospace" font-size="11" fill="#8b949e"> Ed25519 signed · 60s TTL · 28 exchanges · ${x(issuer)}</text>

  <!-- Live pulsing dot -->
  <circle cx="576" cy="299" r="5" fill="${statusColor}">
    <animate attributeName="opacity" values="1;0.25;1" dur="2s" repeatCount="indefinite"/>
  </circle>
  <text x="548" y="303" font-family="'Courier New',Courier,monospace" font-size="11" fill="${statusColor}">LIVE</text>
</svg>`;
}

"""

# Insert function before the badge function comment
BADGE_FUNC_MARKER = '// ── GET /badge/:mic — SVG status badge for embedding in READMEs ─────────'
if BADGE_FUNC_MARKER not in content:
    print("ERROR: Could not find badge route marker. Aborting.")
    exit(1)

# Insert both the function and the route before the badge section
content = content.replace(
    '\t\t' + BADGE_FUNC_MARKER,
    CARD_ROUTE.rstrip() + '\n\n\t\t' + BADGE_FUNC_MARKER
)

# Insert the generateStatusCard function immediately before the badge handler line
# (which now has the card route in front of it)
content = content.replace(
    '\t\t// ── GET /v5/card/:mic — Live SVG status card',
    CARD_FUNCTION.strip() + '\n\n\t\t// ── GET /v5/card/:mic — Live SVG status card'
)

with open(SRC, 'w', encoding='utf-8') as f:
    f.write(content)

print("Done — /v5/card/:mic route and generateStatusCard function inserted.")
print(f"File size: {len(content):,} chars")

"""
Inject the MPAS spec into src/index.ts as a constant and add the /docs/mpas route.
"""
import sys

SRC = "src/index.ts"

# Read the spec and escape for template literal
spec_content = open("docs/multi-party-attestation-spec.md", encoding="utf-8").read()
# Escape for TS template literal: backticks, ${, backslashes
escaped = spec_content.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")

MPAS_CONSTANT = f"const MPAS_SPEC_MD = `{escaped}`;\n"

with open(SRC, "r", encoding="utf-8") as f:
    content = f.read()

# Insert MPAS constant after SMA_RFC_001_MD constant definition
# Find end of SMA_RFC_001_MD (the closing backtick-semicolon line)
ANCHOR = "const SMA_RFC_001_MD = `"
idx = content.find(ANCHOR)
if idx == -1:
    print("ERROR: Could not find SMA_RFC_001_MD anchor")
    sys.exit(1)

# Find the closing `; of SMA_RFC_001_MD
close_idx = content.find("`;\n", idx + len(ANCHOR))
if close_idx == -1:
    print("ERROR: Could not find closing `; of SMA_RFC_001_MD")
    sys.exit(1)

insert_pos = close_idx + len("`;\n")

# Check if already injected
if "MPAS_SPEC_MD" in content:
    print("MPAS_SPEC_MD already present — skipping constant injection")
else:
    content = content[:insert_pos] + "\n" + MPAS_CONSTANT + content[insert_pos:]
    print(f"Injected MPAS_SPEC_MD constant ({len(MPAS_CONSTANT)} chars)")

# Add route handler after SMA RFC route
SMA_ROUTE = "if (p === '/docs/sma-protocol/rfc-001' || p === '/docs/sma-protocol/rfc-001.md')\n\t\t\t\t\treturn new Response(SMA_RFC_001_MD, { headers: p.endsWith('.md') ? mdHeaders : plainHeaders });"
MPAS_ROUTE = "\n\t\t\t\t\tif (p === '/docs/mpas' || p === '/docs/mpas.md')\n\t\t\t\t\t\treturn new Response(MPAS_SPEC_MD, { headers: p.endsWith('.md') ? mdHeaders : plainHeaders });"

if "'/docs/mpas'" in content:
    print("MPAS route already present — skipping route injection")
else:
    if SMA_ROUTE not in content:
        print("ERROR: Could not find SMA route anchor")
        print("Searching for partial match...")
        partial = "'/docs/sma-protocol/rfc-001'"
        idx2 = content.find(partial)
        print(f"Partial found at {idx2}")
        sys.exit(1)
    content = content.replace(SMA_ROUTE, SMA_ROUTE + MPAS_ROUTE, 1)
    print("Injected /docs/mpas route handler")

with open(SRC, "w", encoding="utf-8") as f:
    f.write(content)

print("Done.")

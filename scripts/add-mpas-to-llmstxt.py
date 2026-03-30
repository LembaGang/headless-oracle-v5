"""Add MPAS link to LLMS_TXT and OpenAPI spec in src/index.ts."""
SRC = "src/index.ts"

with open(SRC, "r", encoding="utf-8") as f:
    content = f.read()

# Add to LLMS_TXT
OLD = "- [SMA Protocol RFC-001](https://headlessoracle.com/docs/sma-protocol/rfc-001)\n\n## SDK Documentation"
NEW = "- [SMA Protocol RFC-001](https://headlessoracle.com/docs/sma-protocol/rfc-001)\n- [Multi-Party Attestation Spec (MPAS-1.0)](https://headlessoracle.com/docs/mpas)\n\n## SDK Documentation"

if OLD in content:
    content = content.replace(OLD, NEW, 1)
    print("Added MPAS to LLMS_TXT")
else:
    print("WARNING: LLMS_TXT anchor not found")

# Add /docs/mpas to OpenAPI paths
OPENAPI_MPAS = """
\t\t'/docs/mpas': {
\t\t\tget: {
\t\t\t\ttags: ['Specifications'],
\t\t\t\tsummary: 'Multi-Party Attestation Spec (MPAS-1.0)',
\t\t\t\tdescription: 'MPAS-1.0 specification: how to aggregate receipts from multiple independent oracle operators for threshold verification (2-of-N quorum). Builds on SMA Protocol.',
\t\t\t\tresponses: {
\t\t\t\t\t'200': { description: 'MPAS-1.0 specification document (Markdown)', content: { 'text/plain': {} } },
\t\t\t\t},
\t\t\t},
\t\t},"""

# Insert after the SMA RFC OpenAPI entry
SMA_OPENAPI_ANCHOR = "'/docs/sma-protocol/rfc-001'"
if SMA_OPENAPI_ANCHOR in content and "'/docs/mpas'" not in content:
    # Find the closing of the sma-protocol block (find the next \t\t},\n after anchor)
    idx = content.find(SMA_OPENAPI_ANCHOR)
    # Find the next occurrence of \t\t},\n after this
    close_idx = content.find("\n\t\t},\n", idx)
    if close_idx != -1:
        insert_pos = close_idx + len("\n\t\t},\n")
        content = content[:insert_pos] + OPENAPI_MPAS + "\n" + content[insert_pos:]
        print("Added /docs/mpas to OpenAPI paths")
    else:
        print("WARNING: Could not find closing of sma-protocol OpenAPI block")
else:
    if "'/docs/mpas'" in content:
        print("'/docs/mpas' already in OpenAPI — skipping")
    else:
        print("WARNING: SMA OpenAPI anchor not found")

with open(SRC, "w", encoding="utf-8") as f:
    f.write(content)

print("Done.")

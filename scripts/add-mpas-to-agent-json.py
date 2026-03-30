"""Add MPAS spec reference to AGENT_JSON standards block and server-card.json."""
SRC = "src/index.ts"

with open(SRC, "r", encoding="utf-8") as f:
    content = f.read()

# Add mpas_spec to AGENT_JSON standards block (after conformance_vectors line)
OLD1 = "\t\tconformance_vectors:   'https://api.headlessoracle.com/v5/conformance-vectors',\n\t\tsma_disambiguation:    'SMA denotes Signed Market Attestation, not Simple Moving Average',"
NEW1 = "\t\tconformance_vectors:   'https://api.headlessoracle.com/v5/conformance-vectors',\n\t\tmpas_spec:             'https://headlessoracle.com/docs/mpas',\n\t\tmpas_version:          '1.0',\n\t\tsma_disambiguation:    'SMA denotes Signed Market Attestation, not Simple Moving Average',"

if OLD1 in content:
    content = content.replace(OLD1, NEW1, 1)
    print("Added mpas_spec to AGENT_JSON standards")
else:
    print("WARNING: AGENT_JSON standards anchor not found")

# Also add to server-card standards (similar block near there)
OLD2 = "\t\t\tconformance_vectors:   'https://api.headlessoracle.com/v5/conformance-vectors',\n\t\t\tsma_disambiguation:    'SMA denotes Signed Market Attestation, not Simple Moving Average',"
NEW2 = "\t\t\tconformance_vectors:   'https://api.headlessoracle.com/v5/conformance-vectors',\n\t\t\tmpas_spec:             'https://headlessoracle.com/docs/mpas',\n\t\t\tmpas_version:          '1.0',\n\t\t\tsma_disambiguation:    'SMA denotes Signed Market Attestation, not Simple Moving Average',"

if OLD2 in content:
    content = content.replace(OLD2, NEW2, 1)
    print("Added mpas_spec to server-card standards")
else:
    print("WARNING: server-card standards anchor not found (may use different indentation)")

with open(SRC, "w", encoding="utf-8") as f:
    f.write(content)

print("Done.")

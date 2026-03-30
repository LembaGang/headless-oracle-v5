"""Add MPAS spec reference to server-card.json inline object."""
SRC = "src/index.ts"

with open(SRC, "r", encoding="utf-8") as f:
    content = f.read()

OLD = "\t\t\t\t\tconformance_vectors:   'https://api.headlessoracle.com/v5/conformance-vectors',\n\t\t\t\t\tdst_aware:"
NEW = "\t\t\t\t\tconformance_vectors:   'https://api.headlessoracle.com/v5/conformance-vectors',\n\t\t\t\t\tmpas_spec:             'https://headlessoracle.com/docs/mpas',\n\t\t\t\t\tmpas_version:          '1.0',\n\t\t\t\t\tdst_aware:"

if OLD in content:
    content = content.replace(OLD, NEW, 1)
    print("Added mpas_spec/version to server-card.json inline object")
else:
    print("WARNING: server-card conformance_vectors anchor not found — searching...")
    idx = content.find("conformance_vectors:   'https://api.headlessoracle.com/v5/conformance-vectors',\n\t\t\t\t\tdst_aware:")
    print(f"Alternate search idx: {idx}")

with open(SRC, "w", encoding="utf-8") as f:
    f.write(content)

print("Done.")

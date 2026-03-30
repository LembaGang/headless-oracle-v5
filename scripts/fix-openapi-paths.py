"""
Fix: the new OpenAPI paths were inserted outside the paths: object.
This script moves them inside paths: by restructuring the closing brackets.

Current (wrong) structure:
    paths: {
        ...original paths...
        '/.well-known/agent.json': {...},
    },          <- closes paths: (1 tab)
    '/v5/webhooks/subscribe': {...},  <- OUTSIDE paths
    ...
};

Correct structure:
    paths: {
        ...original paths...
        '/.well-known/agent.json': {...},
        '/v5/webhooks/subscribe': {...},  <- INSIDE paths
        ...
    },          <- closes paths:
};
"""

SRC = "src/index.ts"

with open(SRC, "r", encoding="utf-8") as f:
    content = f.read()

# The current (wrong) state has:
# \t\t},\n  <- closes '/.well-known/agent.json' (from original code)
# \t},\n    <- closes paths: (from replacement - WRONG position)
# \t\t'/v5/webhooks/subscribe': {  <- new paths OUTSIDE paths:
# ...
# \t\t},\n  <- closes '/v5/card/{mic}'
# };\n      <- closes OPENAPI_SPEC

# We need to:
# 1. Remove the early paths: closing `\t},\n`
# 2. Add `\t},\n` after all the new paths (just before `};`)

# Find the boundary: `\t},\n\t\t'/v5/webhooks/subscribe'`
# This is the wrong `\t},` followed by the start of new paths
WRONG_CLOSE = "\t},\n\t\t'/v5/webhooks/subscribe':"
CORRECT_OPEN = "\n\t\t'/v5/webhooks/subscribe':"

if WRONG_CLOSE in content:
    content = content.replace(WRONG_CLOSE, CORRECT_OPEN, 1)
    print("Removed premature paths: closing bracket")
else:
    print("ERROR: Could not find premature closing bracket")
    import sys; sys.exit(1)

# Now add the paths: closing `\t},\n` just before the OPENAPI_SPEC closing `};\n`
# The pattern is: last new path entry closes with `\t\t},\n};`
# We need: `\t\t},\n\t},\n};`
# Find the closing of '/v5/card/{mic}' followed directly by `};`
WRONG_END = "\t\t},\n};"
CORRECT_END = "\t\t},\n\t},\n};"

# Use rfind to get the LAST occurrence (end of OPENAPI_SPEC)
idx = content.rfind(WRONG_END)
if idx != -1:
    # Make sure this is the right occurrence — it should be followed by \n// ─── Signed Receipt
    after = content[idx + len(WRONG_END):idx + len(WRONG_END) + 60]
    if "Signed Receipt" in after or "function buildSignedReceipt" in after or "\n\n" in after[:5]:
        content = content[:idx] + CORRECT_END + content[idx + len(WRONG_END):]
        print("Added paths: closing bracket before OPENAPI_SPEC close")
    else:
        print(f"WARNING: Found WRONG_END but context doesn't match. After: {repr(after[:50])}")
        # Try anyway with the last occurrence
        content = content[:idx] + CORRECT_END + content[idx + len(WRONG_END):]
        print("Applied anyway (last occurrence)")
else:
    print("ERROR: Could not find OPENAPI_SPEC end pattern")
    import sys; sys.exit(1)

with open(SRC, "w", encoding="utf-8") as f:
    f.write(content)

print("Done. Verify with: grep -n \"paths:\" src/index.ts")

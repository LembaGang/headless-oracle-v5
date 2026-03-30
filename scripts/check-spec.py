import sys
content = open('docs/multi-party-attestation-spec.md', encoding='utf-8').read()
backtick_count = content.count('`')
dollar_brace = content.count('${')
backslash_count = content.count('\\')
print(f'backticks: {backtick_count}, dollar-braces: {dollar_brace}, backslashes: {backslash_count}')
print(f'Total chars: {len(content)}')
# Show first backtick context
idx = content.find('`')
if idx >= 0:
    print(f'First backtick at {idx}: ...{repr(content[max(0,idx-20):idx+30])}...')

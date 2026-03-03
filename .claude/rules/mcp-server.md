# MCP Server Rules
Protocol: MCP 2024-11-05 over HTTP+SSE (POST /mcp). JSON-RPC 2.0.
Tools: get_market_status, get_market_schedule, list_exchanges.
Required methods: tools/list, tools/call, resources/list (empty), prompts/list (empty).
Tool descriptions are critical — they determine whether AI agents choose to use us. Must state what, when, valid MICs, crypto verification, and non-OPEN means do not trade.
Adding new methods: add before default -32601 case, return appropriate response, add test, redeploy.

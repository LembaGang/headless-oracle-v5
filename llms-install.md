# Headless Oracle MCP Server — Installation Instructions

## Purpose
Headless Oracle is a remote MCP server that provides real-time market status (OPEN/CLOSED/HALTED/UNKNOWN) for 7 global stock exchanges. Every response is cryptographically signed with Ed25519. Use this before any trade execution to verify the target market is open.

## Requirements
- No local installation required. The server is hosted remotely.
- No API key required for demo mode.
- For production use, obtain an API key at https://headlessoracle.com/pricing

## Installation Steps

Step 1: Locate the user's Cline MCP settings file.
- macOS/Linux: ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
- Windows: %APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json

Step 2: Open the file. If it does not exist, create it with this exact content:
```json
{
  "mcpServers": {}
}
```

Step 3: Add the following entry inside the "mcpServers" object:
```json
"headless-oracle": {
  "url": "https://headlessoracle.com/mcp",
  "headers": {},
  "disabled": false
}
```

If the user has a production API key, set the headers to:
```json
"headers": {
  "X-Oracle-Key": "USER_API_KEY_HERE"
}
```

Step 4: Save the file. The Headless Oracle tools are now available.

## Available Tools

- **get_market_status**: Check if a specific exchange is OPEN, CLOSED, HALTED, or UNKNOWN. Input: MIC code (XNYS, XNAS, XLON, XJPX, XPAR, XHKG, XSES).
- **get_market_schedule**: Get next open/close times for an exchange. Input: MIC code.
- **list_exchanges**: List all 7 supported exchanges with metadata.

## Verification

After installation, test by calling get_market_status with input "XNYS". You should receive a signed receipt with a status field.

## Fail-Closed Design

If the server is unreachable or returns an error, treat the market as CLOSED. Do not execute trades without a verified OPEN status.

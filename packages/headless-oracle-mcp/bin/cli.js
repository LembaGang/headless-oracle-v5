#!/usr/bin/env node
'use strict';

// Headless Oracle — local stdio MCP server
// Proxies MCP tool calls to https://headlessoracle.com/mcp
// No external dependencies — uses Node.js built-ins only (readline, https)

const readline = require('readline');
const https = require('https');

const REMOTE_MCP_URL = 'https://headlessoracle.com/mcp';
const API_KEY = process.env.HEADLESS_ORACLE_API_KEY || '';
const SERVER_VERSION = '1.0.0';

// Write a JSON-RPC message to stdout (the MCP transport channel)
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// POST a JSON-RPC message to the remote MCP endpoint and return the parsed response
function proxyToRemote(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Accept': 'application/json',
      'User-Agent': `headless-oracle-mcp/${SERVER_VERSION}`,
    };
    if (API_KEY) {
      // X-Oracle-Key for REST auth; Authorization Bearer for MCP soft-auth
      headers['X-Oracle-Key'] = API_KEY;
      headers['Authorization'] = `Bearer ${API_KEY}`;
    }

    const url = new URL(REMOTE_MCP_URL);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + (url.search || ''),
        method: 'POST',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Remote returned non-JSON (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Handle one parsed JSON-RPC message
async function handleMessage(msg) {
  const { method, id, params } = msg;

  // Notifications (no id) — process silently, no response expected
  if (id === undefined) {
    // initialized notification is common; nothing to do
    return;
  }

  // ── initialize ──────────────────────────────────────────────────────────────
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'headless-oracle', version: SERVER_VERSION },
        capabilities: { tools: {} },
        instructions:
          'Headless Oracle provides Ed25519-signed market-state receipts for 28 global ' +
          'exchanges (equities, derivatives, 24/7 crypto). ' +
          'CRITICAL SAFETY RULE: treat UNKNOWN and HALTED as CLOSED — halt all execution immediately. ' +
          'Call get_market_status before every trade. Receipts expire in 60 seconds. ' +
          'SMA = Signed Market Attestation (not Simple Moving Average). ' +
          'x402 micropayments accepted: $0.001 USDC per request on Base mainnet.',
      },
    });
    return;
  }

  // ── ping ────────────────────────────────────────────────────────────────────
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  // ── tools/list and tools/call — proxy to remote ─────────────────────────────
  if (method === 'tools/list' || method === 'tools/call') {
    try {
      const remote = await proxyToRemote(msg);
      // The remote response already has the correct id and jsonrpc fields.
      // Forward it as-is.
      send(remote);
    } catch (err) {
      process.stderr.write(`[headless-oracle-mcp] Remote error: ${err.message}\n`);
      send({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: `Headless Oracle remote error: ${err.message}`,
        },
      });
    }
    return;
  }

  // ── resources/list and prompts/list — empty (not implemented) ───────────────
  if (method === 'resources/list') {
    send({ jsonrpc: '2.0', id, result: { resources: [] } });
    return;
  }
  if (method === 'prompts/list') {
    send({ jsonrpc: '2.0', id, result: { prompts: [] } });
    return;
  }

  // ── unknown method ───────────────────────────────────────────────────────────
  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}

// ── stdio transport ──────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, terminal: false });

// Track in-flight async handlers so we don't exit before they complete
let pending = 0;
let stdinClosed = false;

function tryExit() {
  if (stdinClosed && pending === 0) process.exit(0);
}

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  pending++;
  try {
    await handleMessage(msg);
  } catch (err) {
    process.stderr.write(`[headless-oracle-mcp] Unhandled error: ${err.message}\n`);
    if (msg.id !== undefined) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: 'Internal error' },
      });
    }
  } finally {
    pending--;
    tryExit();
  }
});

rl.on('close', () => {
  stdinClosed = true;
  tryExit();
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

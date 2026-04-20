# Geni MCP Plugin

Use this plugin when a request needs Geni MCP tool calls that require Kerberos-backed token injection.

## What it provides

- Registers a `geni` MCP server from `mcp.json`.
- Runs a `PreToolUse` hook from `hooks.json`.
- Injects `axonToken` and `newAxonToken` for Axon tool calls.
- Injects `ibiToken` and `newIbiToken` for HSDIndex tool calls.

## Requirements

- Valid Kerberos ticket on the machine.
- Node.js and curl available in PATH.
- The MCP server must accept the injected token fields.

## Verification

Use the smoke test from `README.md` and check `%TEMP%/geni-mcp/hook.log` for invocation evidence.

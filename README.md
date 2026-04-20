# Geni MCP Plugin

VS Code agent plugin that registers the Geni MCP server and injects
Kerberos-backed tokens into `AxonTool` and `HSDIndexTool` calls via a
`PreToolUse` hook.

Replaces the `GeniMCPExtension` VS Code extension. AAD sign-in is handled
by VS Code's built-in MCP OAuth flow; the plugin only deals with the
Kerberos-derived `axonToken` / `ibiToken`.

## Requirements

- VS Code **1.116** or newer (agent plugins + hooks, Preview).
- Node.js available on `PATH` (ships with the VS Code agent runtime).
- `curl` available on `PATH` (`curl.exe` on Windows ships with Win10+; native
  on Linux).
- Valid Kerberos ticket (`kinit` on Linux, automatic with Windows domain login).
- **Server-side support**: the Geni MCP server must accept `axonToken` /
  `ibiToken` as input fields on `AxonTool` / `HSDIndexTool`.

## Layout

```
plugin.json              Plugin manifest
mcp.json                 Geni MCP server registration (HTTP, no headers)
hooks.json               PreToolUse hook registration
hooks/inject-token.mjs   Hook script (Node.js, no external deps)
```

## How it works

1. `mcp.json` registers the Geni MCP server. VS Code's built-in OAuth flow
   handles the AAD bearer token (the same flow used when no extension is
   installed).
2. Before every tool call, the `PreToolUse` hook runs `node hooks/inject-token.mjs`.
3. The hook inspects `tool_name`:
   - `AxonTool` → mints an Axon token via Kerberos and adds it to the tool
     input as `axonToken`.
   - `HSDIndexTool` → mints an IBI token via Kerberos and adds it as
     `ibiToken`.
   - anything else → no-op.
4. Tokens are cached under `${TMPDIR}/geni-mcp/tokens.json` for 30 minutes
   (mode `0o600`) to avoid a Kerberos round-trip on every call.

If Kerberos fails, the hook emits a `systemMessage` warning and lets the
call proceed (the server will return its own auth error). The hook never
blocks other tools.

## Install

Install directly from GitHub with either of these forms:

- `/plugin install orlyabramovich/plugin_test`
- `/plugin install https://github.com/orlyabramovich/plugin_test`

This repo also includes marketplace metadata at `.github/plugin/marketplace.json`
for marketplace-based plugin discovery.

You can still install manually by copying this folder into your Copilot plugins
directory (typically `~/.copilot/plugins/geni-mcp-plugin/`).

After install, uninstall the old `GeniMCPExtension` to avoid registering
the server twice.

## Smoke test

```powershell
'{"tool_name":"AxonTool","tool_input":{"foo":"bar"}}' | node hooks\inject-token.mjs
```

Expected stdout (token elided):

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"foo":"bar","axonToken":"…"}}}
```

For an unrelated tool, stdout is empty:

```powershell
'{"tool_name":"editFiles","tool_input":{}}' | node hooks\inject-token.mjs
```

## Sign out

Delete the token cache:

```powershell
Remove-Item -Recurse -Force "$env:TEMP\geni-mcp"
```

For AAD, use VS Code's MCP server menu → Sign Out.

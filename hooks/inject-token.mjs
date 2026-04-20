#!/usr/bin/env node
// Geni MCP Plugin — PreToolUse hook
// Injects Kerberos-backed tokens into AxonTool / HSDIndexTool calls.
//
// Reads a PreToolUse JSON event from stdin, and on AxonTool / HSDIndexTool
// invocations adds an `axonToken` / `ibiToken` field to the tool input via
// `hookSpecificOutput.updatedInput`. For any other tool, exits cleanly with
// no modification. Tokens are cached on disk for TOKEN_TTL_MS to avoid a
// Kerberos round-trip on every tool call.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const IBI_TOKEN_URL  = 'https://ibi-daas-api.intel.com/login';
const AXON_TOKEN_URL = 'https://axon.intel.com/api/v1/token';
const CURL_TIMEOUT_MS = 30_000;
const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 min

const CACHE_DIR = join(tmpdir(), 'geni-mcp');
const CACHE_FILE = join(CACHE_DIR, 'tokens.json');
const HOOK_LOG_FILE = join(CACHE_DIR, 'hook.log');
const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = SCRIPT_FILE.substring(0, SCRIPT_FILE.lastIndexOf(platform() === 'win32' ? '\\' : '/'));
const LOG_TARGETS = [
    HOOK_LOG_FILE,
    join(SCRIPT_DIR, 'hook.runtime.log'),
    join(process.cwd(), 'geni-hook.runtime.log')
];

function tryAppend(file, line) {
    try {
        const sep = platform() === 'win32' ? '\\' : '/';
        const idx = file.lastIndexOf(sep);
        if (idx > 0) {
            mkdirSync(file.substring(0, idx), { recursive: true });
        }
        writeFileSync(file, line + '\n', { flag: 'a', mode: 0o600 });
    } catch {
        // best-effort only; never block tool calls on debug logging.
    }
}

function appendHookLog(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    for (const target of LOG_TARGETS) {
        tryAppend(target, line);
    }
}

function isToolName(toolName, canonicalName) {
    if (!toolName) return false;
    if (toolName === canonicalName) return true;
    return toolName.endsWith(`_${canonicalName}`) || toolName.endsWith(`/${canonicalName}`) || toolName.endsWith(`:${canonicalName}`);
}

function log(...args) {
    // stderr only — stdout is reserved for the JSON hook response.
    const line = '[geni-mcp-hook] ' + args.join(' ');
    process.stderr.write(line + '\n');
    appendHookLog(line);
}

function readCache() {
    try {
        if (!existsSync(CACHE_FILE)) return {};
        return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    } catch (err) {
        log('cache read failed:', err.message);
        return {};
    }
}

function writeCache(cache) {
    try {
        mkdirSync(CACHE_DIR, { recursive: true });
        writeFileSync(CACHE_FILE, JSON.stringify(cache), { mode: 0o600 });
    } catch (err) {
        log('cache write failed:', err.message);
    }
}

function getCached(key) {
    const cache = readCache();
    const entry = cache[key];
    if (!entry) return undefined;
    if (Date.now() - entry.ts > TOKEN_TTL_MS) return undefined;
    return entry.token;
}

function putCached(key, token) {
    const cache = readCache();
    cache[key] = { token, ts: Date.now() };
    writeCache(cache);
}

async function curlWithKerberos(url, { insecure = false } = {}) {
    const curl = platform() === 'win32' ? 'curl.exe' : 'curl';
    const args = ['--negotiate', '-u', ':', '-s', '-f', '-L'];
    if (insecure) args.push('-k');
    args.push(url);
    const { stdout } = await execFileAsync(curl, args, { timeout: CURL_TIMEOUT_MS });
    return stdout.trim();
}

async function getAxonToken() {
    const cached = getCached('axon');
    if (cached) {
        appendHookLog('Axon token cache hit');
        return cached;
    }
    log('fetching Axon-Token via Kerberos...');
    const body = await curlWithKerberos(AXON_TOKEN_URL);
    const token = JSON.parse(body).token;
    if (!token) throw new Error('Axon response did not contain `token`');
    putCached('axon', token);
    return token;
}

async function getIbiToken() {
    const cached = getCached('ibi');
    if (cached) {
        appendHookLog('ibi-token cache hit');
        return cached;
    }
    log('fetching ibi-token via Kerberos...');
    const body = await curlWithKerberos(IBI_TOKEN_URL, { insecure: true });
    const token = JSON.parse(body).accessToken;
    if (!token) throw new Error('IBI response did not contain `accessToken`');
    putCached('ibi', token);
    return token;
}

function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { data += chunk; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}

function emit(obj) {
    process.stdout.write(JSON.stringify(obj));
}

function emitUpdatedInput(updatedInput) {
    emit({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput
        }
    });
}

function emitWarning(message) {
    emit({ systemMessage: message });
}

async function main() {
    let event;
    try {
        const raw = await readStdin();
        event = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
        log('failed to parse stdin:', err.message);
        process.exit(0); // never block other tools
    }

    const toolName = event.tool_name;
    const toolInput = event.tool_input ?? {};
    appendHookLog(`invoke tool=${toolName ?? '<undefined>'} cwd=${process.cwd()} script=${SCRIPT_FILE} temp=${tmpdir()} inputKeys=${Object.keys(toolInput).join(',') || '<none>'}`);

    try {
        if (isToolName(toolName, 'AxonTool')) {
            const axonToken = await getAxonToken();
            // Populate both field names to support old/new server schemas.
            emitUpdatedInput({ ...toolInput, axonToken, newAxonToken: axonToken });
            appendHookLog('AxonTool injected keys=axonToken,newAxonToken');
        } else if (isToolName(toolName, 'HSDIndexTool')) {
            const ibiToken = await getIbiToken();
            // Populate both field names to support old/new server schemas.
            emitUpdatedInput({ ...toolInput, ibiToken, newIbiToken: ibiToken });
            appendHookLog('HSDIndexTool injected keys=ibiToken,newIbiToken');
        } else {
            appendHookLog(`no-op tool=${toolName ?? '<undefined>'}`);
        }
        // otherwise: no-op, empty stdout
        process.exit(0);
    } catch (err) {
        log(`token injection failed for ${toolName}:`, err.message);
        // exit 0 + warning — let the server return its own auth error rather
        // than hiding the call from the model with exit 2.
        emitWarning(`Geni MCP: failed to acquire token for ${toolName} (${err.message}). The tool call will proceed without injected credentials.`);
        process.exit(0);
    }
}

main();

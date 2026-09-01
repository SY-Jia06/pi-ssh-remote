/**
 * Pi SSH Remote extension.
 *
 * Provides persistent SSH workspaces for Pi by routing file and shell tools to
 * a verified remote host. It manages endpoint configuration, in-memory
 * credentials, remote working directories, reconnection, and TCP forwarding.
 */

import ssh2, { type Client as SshClient, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_DIR_NAME,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  formatSize,
  keyHint,
  truncateHead,
  truncateTail,
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, Text, matchesKey, truncateToWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { sshRouteId } from "./route-identity.js";
import { authenticationSteps, createAuthHandler, isRecoverableAuthenticationError, parseOpenSshConfigOutput, resolveIdentityAgent, shouldInvalidateCachedPassword, shouldPromptForPassword } from "./ssh-auth.js";

const { Client, utils: ssh2Utils } = ssh2;

interface ParsedSsh {
  host: string;
  port: number;
  username: string;
  identityFiles: string[];
  identitiesOnly: boolean;
  identityAgent?: string;
  explicitIdentityFile?: string;
  /** Original OpenSSH target, such as pimei01-jia or user@host. */
  sshTarget: string;
  /** Effective ProxyJump value from the local OpenSSH configuration. */
  proxyJump?: string;
  label: string;
  command: string;
}

interface SshProxy {
  socket: Duplex;
  close: () => void;
}

interface RemoteState extends ParsedSsh {
  client: SshClient;
  cwd: string;
}

interface CredentialCache {
  passwords: Map<string, string>;
  keyPassphrases: Map<string, string>;
  resume?: { command: string; cwd: string; routeRemoteTools: boolean; forwards?: string[] };
}

interface OutputCursor {
  endpoint: string;
  command: string;
  cwd: string;
  output: string;
}

interface RemoteJob {
  id: string;
  endpoint: string;
  cwd: string;
  log: string;
  pid?: number;
  session?: string;
  startedAt: string;
  lastStatus?: Record<string, unknown>;
}

interface RuntimeCache {
  cursors: Map<string, OutputCursor>;
  artifacts: Map<string, string>;
  jobs: Map<string, RemoteJob>;
  outputDir?: string;
  outputCleanupRegistered?: boolean;
}

interface RemoteEndpointConfig {
  sshCommand?: string;
  remoteCwd?: string;
  forwards?: string[];
  note?: string;
  /** Legacy field migrated into serverMemories on the next config write. */
  memory?: string;
}

interface ServerMemoryEntry {
  id: string;
  content: string;
}

interface ServerMemoryFile {
  server: string;
  entries: ServerMemoryEntry[];
}

interface RemoteConfig {
  activeEndpoint?: string;
  endpoints?: Record<string, RemoteEndpointConfig>;
  /** Legacy values migrated into per-server JSON files at extension startup. */
  serverMemories?: Record<string, string>;
  displayLines?: number;
  readMaxLines?: number;
  readMaxBytes?: number;
  execMaxLines?: number;
  execMaxBytes?: number;
  turnMaxBytes?: number;
  /** Legacy fields migrated into endpoints on the next config write. */
  sshCommand?: string;
  remoteCwd?: string;
  forwards?: string[];
}

interface ForwardSpec {
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

interface SessionRemoteState {
  version: 1;
  connected: boolean;
  command?: string;
  cwd?: string;
  routeRemoteTools?: boolean;
  forwards?: string[];
}

const AGENT_DIR = join(process.env.HOME || ".", CONFIG_DIR_NAME, "agent");
const KNOWN_HOSTS_FILE = join(AGENT_DIR, "ssh-remote-known-hosts.json");
const REMOTE_CONFIG_FILE = join(AGENT_DIR, "ssh-remote-config.json");
const SERVER_MEMORY_DIR = join(AGENT_DIR, "ssh-remote-memories");
const FALLBACK_REMOTE_CWD = "~";
const DEFAULT_DISPLAY_LINES = 5;
const MAX_DISPLAY_LINES = 50;
const DEFAULT_READ_MAX_LINES = 400;
const DEFAULT_READ_MAX_BYTES = 16 * 1024;
const DEFAULT_EXEC_MAX_LINES = 200;
const DEFAULT_EXEC_MAX_BYTES = 8 * 1024;
const DEFAULT_TURN_MAX_BYTES = 32 * 1024;
const MIN_MODEL_OUTPUT_BYTES = 1024;
const OUTPUT_FOOTER_RESERVE_BYTES = 512;
const DEFAULT_REMOTE_TIMEOUT_SECONDS = 30;
const SSH_CONNECT_TIMEOUT_MS = 12000;
const MAX_REMOTE_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
const MAX_PRIVATE_KEY_BYTES = 1024 * 1024;
const MAX_RUNTIME_ENTRIES = 128;
const DEFAULT_LONG_OUTPUT_SUMMARY_LINES = 8;
const DEFAULT_LONG_OUTPUT_SUMMARY_BYTES = 2 * 1024;
const DEFAULT_FANOUT_LINES = 12;
const DEFAULT_FANOUT_BYTES = 2 * 1024;
const SESSION_STATE_ENTRY_TYPE = "pi-ssh-remote-state";
const CACHE_KEY = "__piHpcCredentialCacheV1";
const RUNTIME_CACHE_KEY = "__piSshRemoteRuntimeCacheV1";
const cacheHost = globalThis as typeof globalThis & {
  [CACHE_KEY]?: CredentialCache;
  [RUNTIME_CACHE_KEY]?: RuntimeCache;
};
const credentialCache = cacheHost[CACHE_KEY] ??= { passwords: new Map<string, string>(), keyPassphrases: new Map<string, string>() };
credentialCache.keyPassphrases ??= new Map<string, string>();
const runtimeCache = cacheHost[RUNTIME_CACHE_KEY] ??= {
  cursors: new Map<string, OutputCursor>(),
  artifacts: new Map<string, string>(),
  jobs: new Map<string, RemoteJob>(),
};
if (!runtimeCache.outputCleanupRegistered) {
  runtimeCache.outputCleanupRegistered = true;
  process.once("exit", () => cleanupRuntimeOutputs());
}

function shellWords(input: string): string[] {
  const words: string[] = [];
  let word = "";
  let quoteChar: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of input.trim()) {
    if (escaped) { word += ch; escaped = false; continue; }
    if (ch === "\\" && quoteChar !== "'") { escaped = true; continue; }
    if (quoteChar) { if (ch === quoteChar) quoteChar = null; else word += ch; continue; }
    if (ch === "'" || ch === '"') { quoteChar = ch; continue; }
    if (/\s/.test(ch)) { if (word) { words.push(word); word = ""; } }
    else word += ch;
  }
  if (escaped || quoteChar) throw new Error("Incomplete quoting or escaping in SSH command");
  if (word) words.push(word);
  return words;
}

interface OpenSshConfig {
  hostname?: string;
  port?: number;
  user?: string;
  identityFiles: string[];
  identitiesOnly?: boolean;
  identityAgent?: string;
  proxyJump?: string;
}

function resolveOpenSshConfig(target: string, loginUser: string | undefined, port: number | undefined, identityFile: string | undefined): OpenSshConfig | undefined {
  const args = ["-G"];
  if (loginUser) args.push("-l", loginUser);
  if (port !== undefined) args.push("-p", String(port));
  if (identityFile) args.push("-i", identityFile);
  args.push(target);
  try {
    const output = execFileSync("ssh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }) as string;
    return parseOpenSshConfigOutput(output) as OpenSshConfig;
  } catch {
    // Keep literal host behavior if OpenSSH is unavailable or rejects -G.
    return undefined;
  }
}

function parseSshCommand(command: string): ParsedSsh {
  const args = shellWords(command);
  if (args[0] !== "ssh") throw new Error("Command must start with ssh, for example: ssh root@host -p 22");
  let port = 22;
  let explicitPort: number | undefined;
  let username = process.env.USER || "root";
  let loginUser: string | undefined;
  let identityFile: string | undefined;
  let target: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-p") { port = Number(args[++i]); explicitPort = port; continue; }
    if (arg.startsWith("-p") && arg.length > 2) { port = Number(arg.slice(2)); explicitPort = port; continue; }
    if (arg === "-l") { loginUser = args[++i] || username; username = loginUser; continue; }
    if (arg === "-i") {
      if (identityFile !== undefined) throw new Error("Only one SSH identity file may be specified");
      identityFile = args[++i];
      if (!identityFile) throw new Error("SSH option -i requires a private key path");
      continue;
    }
    if (arg.startsWith("-i") && arg.length > 2) {
      if (identityFile !== undefined) throw new Error("Only one SSH identity file may be specified");
      identityFile = arg.slice(2);
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unsupported SSH option ${arg}; only -p, -l, and -i are currently supported`);
    if (!target) target = arg;
    else throw new Error("Unexpected extra argument in SSH command");
  }
  if (!target || (explicitPort !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))) throw new Error("Invalid SSH host or port");
  if (identityFile && identityFile !== "~" && !identityFile.startsWith("~/") && !isAbsolute(identityFile)) {
    throw new Error("SSH identity file must use an absolute path or ~/...");
  }
  const at = target.lastIndexOf("@");
  const requestedHost = at >= 0 ? target.slice(at + 1) : target;
  if (at >= 0) username = target.slice(0, at);
  if (!requestedHost || !username) throw new Error("Invalid SSH username or host");

  const sshConfig = resolveOpenSshConfig(target, loginUser, explicitPort, identityFile);
  const usesOpenSshAlias = Boolean(sshConfig && (
    Boolean(sshConfig.proxyJump) ||
    sshConfig.hostname !== requestedHost ||
    sshConfig.port !== undefined && sshConfig.port !== 22 ||
    sshConfig.user !== undefined && sshConfig.user !== username
  ));
  const identityFiles = [...new Set(identityFile ? [identityFile] : (sshConfig?.identityFiles ?? []))];
  const effectiveHost = sshConfig?.hostname || requestedHost;
  const effectivePort = sshConfig?.port || port;
  const effectiveUser = sshConfig?.user || username;
  const proxyJump = sshConfig?.proxyJump;
  if (!Number.isInteger(effectivePort) || effectivePort < 1 || effectivePort > 65535) throw new Error("Invalid SSH host or port");
  return {
    host: effectiveHost,
    port: effectivePort,
    username: effectiveUser,
    identityFiles,
    identitiesOnly: sshConfig?.identitiesOnly ?? false,
    ...(sshConfig?.identityAgent ? { identityAgent: sshConfig.identityAgent } : {}),
    ...(identityFile ? { explicitIdentityFile: identityFile } : {}),
    sshTarget: target,
    ...(proxyJump ? { proxyJump } : {}),
    label: usesOpenSshAlias ? target : `${effectiveUser}@${effectiveHost}:${effectivePort}`,
    command,
  };
}

function cacheId(config: ParsedSsh): string {
  return sshRouteId(config);
}

function legacyServerMemoryId(config: ParsedSsh): string {
  return `${config.username}@${config.host}`;
}

function serverMemoryId(config: ParsedSsh): string {
  return cacheId(config);
}

function getCachedPassword(config: ParsedSsh): string | undefined {
  return credentialCache.passwords.get(cacheId(config));
}

function setCachedPassword(config: ParsedSsh, password: string): void {
  credentialCache.passwords.set(cacheId(config), password);
}

function deleteCachedPassword(config: ParsedSsh): void {
  credentialCache.passwords.delete(cacheId(config));
}

function resolveIdentityPath(identityFile: string): string {
  if (identityFile === "~" || identityFile.startsWith("~/")) {
    const home = process.env.HOME;
    if (!home) throw new Error("Cannot expand SSH identity path because HOME is not set");
    return identityFile === "~" ? home : join(home, identityFile.slice(2));
  }
  return identityFile;
}

function keyPassphraseId(config: ParsedSsh, identityFile: string): string {
  return `${cacheId(config)}|${resolveIdentityPath(identityFile)}`;
}

function getCachedKeyPassphrase(config: ParsedSsh, identityFile: string): string | undefined {
  return credentialCache.keyPassphrases.get(keyPassphraseId(config, identityFile));
}

function setCachedKeyPassphrase(config: ParsedSsh, identityFile: string, passphrase: string): void {
  credentialCache.keyPassphrases.set(keyPassphraseId(config, identityFile), passphrase);
}

function deleteCachedKeyPassphrase(config: ParsedSsh, identityFile?: string): void {
  for (const file of identityFile ? [identityFile] : config.identityFiles) {
    credentialCache.keyPassphrases.delete(keyPassphraseId(config, file));
  }
}

function readPrivateKey(identityFile: string): Buffer {
  const path = resolveIdentityPath(identityFile);
  let stat;
  try { stat = statSync(path); }
  catch (error) { throw new Error(`Cannot access SSH private key ${path}: ${(error as Error).message}`); }
  if (!stat.isFile()) throw new Error(`SSH private key is not a regular file: ${path}`);
  if (stat.size > MAX_PRIVATE_KEY_BYTES) throw new Error(`SSH private key exceeds the ${MAX_PRIVATE_KEY_BYTES}-byte limit: ${path}`);
  try { return readFileSync(path); }
  catch (error) { throw new Error(`Cannot read SSH private key ${path}: ${(error as Error).message}`); }
}

function parsePrivateKey(keyData: Buffer, passphrase?: string): any | Error {
  let parsed: any;
  try { parsed = ssh2Utils.parseKey(keyData, passphrase); }
  catch (error) { return error as Error; }
  if (parsed instanceof Error) return parsed;
  const keys = Array.isArray(parsed) ? parsed : [parsed];
  const privateKeys = keys.filter((key) => key?.isPrivateKey?.());
  if (privateKeys.length !== 1) {
    return new Error(privateKeys.length ? "SSH identity files containing multiple private keys are not supported" : "SSH identity file does not contain a private key");
  }
  return privateKeys[0];
}

function isPassphraseError(error: Error): boolean {
  return /passphrase|encrypted private/i.test(error.message);
}

function parseForwardSpec(value: string): ForwardSpec {
  const match = value.match(/^(\d+):([^:]+):(\d+)$/);
  if (!match) throw new Error(`Invalid port-forward specification: ${value}; expected LOCAL_PORT:REMOTE_HOST:REMOTE_PORT`);
  const localPort = Number(match[1]);
  const remoteHost = match[2]!;
  const remotePort = Number(match[3]);
  if (![localPort, remotePort].every((port) => Number.isInteger(port) && port > 0 && port <= 65535)) {
    throw new Error(`Port out of range in forwarding specification: ${value}`);
  }
  return { localPort, remoteHost, remotePort };
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseBoundedInteger(value: unknown, label: string, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function parseDisplayLines(value: unknown): number {
  return parseBoundedInteger(value, "Display lines", MAX_DISPLAY_LINES);
}

function parseOutputLines(value: unknown, label: string): number {
  return parseBoundedInteger(value, label, DEFAULT_MAX_LINES);
}

function parseOutputBytes(value: unknown, label: string, maximum = DEFAULT_MAX_BYTES): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_MODEL_OUTPUT_BYTES || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${MIN_MODEL_OUTPUT_BYTES} to ${maximum}`);
  }
  return parsed;
}

function parseRemoteTimeout(value: unknown): number {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_REMOTE_TIMEOUT_SECONDS) {
    throw new Error(`Timeout must be a positive number no greater than ${MAX_REMOTE_TIMEOUT_SECONDS} seconds`);
  }
  return seconds;
}

function withRemoteTimeout(command: string, timeoutSeconds: number): string {
  return `timeout --signal=TERM --kill-after=5s ${timeoutSeconds}s bash -lc ${quote(command)}`;
}

function configuredDisplayLines(config = loadRemoteConfig()): number {
  try { return parseDisplayLines(config.displayLines ?? DEFAULT_DISPLAY_LINES); }
  catch { return DEFAULT_DISPLAY_LINES; }
}

function configuredOutputLimits(config = loadRemoteConfig()) {
  const readMaxLines = (() => { try { return parseOutputLines(config.readMaxLines ?? DEFAULT_READ_MAX_LINES, "Read max lines"); } catch { return DEFAULT_READ_MAX_LINES; } })();
  const readMaxBytes = (() => { try { return parseOutputBytes(config.readMaxBytes ?? DEFAULT_READ_MAX_BYTES, "Read max bytes"); } catch { return DEFAULT_READ_MAX_BYTES; } })();
  const execMaxLines = (() => { try { return parseOutputLines(config.execMaxLines ?? DEFAULT_EXEC_MAX_LINES, "Exec max lines"); } catch { return DEFAULT_EXEC_MAX_LINES; } })();
  const execMaxBytes = (() => { try { return parseOutputBytes(config.execMaxBytes ?? DEFAULT_EXEC_MAX_BYTES, "Exec max bytes"); } catch { return DEFAULT_EXEC_MAX_BYTES; } })();
  const turnMaxBytes = (() => { try { return parseOutputBytes(config.turnMaxBytes ?? DEFAULT_TURN_MAX_BYTES, "Turn max bytes", DEFAULT_MAX_BYTES * 4); } catch { return DEFAULT_TURN_MAX_BYTES; } })();
  return { readMaxLines, readMaxBytes, execMaxLines, execMaxBytes, turnMaxBytes };
}

function commandFromEndpointKey(key: string): string | undefined {
  const match = key.match(/^([^@]+)@(.+):(\d+)$/);
  if (!match) return undefined;
  const [, username, host, port] = match;
  return `ssh ${username}@${host} -p ${port}`;
}

function normalizeRemoteConfig(config: RemoteConfig): RemoteConfig {
  const endpoints: Record<string, RemoteEndpointConfig> = {};
  const serverMemories = Object.fromEntries(
    Object.entries(config.serverMemories ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1].trim()))
      .map(([key, memory]) => [key, memory.trim()]),
  );
  let activeEndpoint: string | undefined;
  const endpointEntries = Object.entries(config.endpoints ?? {}).sort(([left], [right]) =>
    left === config.activeEndpoint ? -1 : right === config.activeEndpoint ? 1 : 0,
  );
  for (const [oldKey, endpoint] of endpointEntries) {
    const command = endpoint.sshCommand || commandFromEndpointKey(oldKey);
    const { memory: legacyMemory, ...endpointWithoutMemory } = endpoint;
    let key = oldKey;
    let parsed: ParsedSsh | undefined;
    if (command) {
      try {
        parsed = parseSshCommand(command);
        key = cacheId(parsed);
      } catch {}
    }
    endpoints[key] = {
      ...endpointWithoutMemory,
      ...(command ? { sshCommand: command } : {}),
      ...(endpoints[key] ?? {}),
    };
    if (oldKey === config.activeEndpoint) activeEndpoint = key;
    if (legacyMemory?.trim() && parsed) serverMemories[serverMemoryId(parsed)] ??= legacyMemory.trim();
  }

  if (config.sshCommand) {
    try {
      const key = cacheId(parseSshCommand(config.sshCommand));
      endpoints[key] = {
        ...(endpoints[key] ?? {}),
        sshCommand: config.sshCommand,
        ...(config.remoteCwd !== undefined ? { remoteCwd: config.remoteCwd } : {}),
        ...(config.forwards !== undefined ? { forwards: config.forwards } : {}),
      };
      activeEndpoint ??= key;
    } catch {}
  }
  if (activeEndpoint && !endpoints[activeEndpoint]) activeEndpoint = undefined;
  activeEndpoint ??= Object.keys(endpoints)[0];
  let displayLines: number | undefined;
  let readMaxLines: number | undefined;
  let readMaxBytes: number | undefined;
  let execMaxLines: number | undefined;
  let execMaxBytes: number | undefined;
  let turnMaxBytes: number | undefined;
  try { displayLines = config.displayLines === undefined ? undefined : parseDisplayLines(config.displayLines); } catch {}
  try { readMaxLines = config.readMaxLines === undefined ? undefined : parseOutputLines(config.readMaxLines, "Read max lines"); } catch {}
  try { readMaxBytes = config.readMaxBytes === undefined ? undefined : parseOutputBytes(config.readMaxBytes, "Read max bytes"); } catch {}
  try { execMaxLines = config.execMaxLines === undefined ? undefined : parseOutputLines(config.execMaxLines, "Exec max lines"); } catch {}
  try { execMaxBytes = config.execMaxBytes === undefined ? undefined : parseOutputBytes(config.execMaxBytes, "Exec max bytes"); } catch {}
  try { turnMaxBytes = config.turnMaxBytes === undefined ? undefined : parseOutputBytes(config.turnMaxBytes, "Turn max bytes", DEFAULT_MAX_BYTES * 4); } catch {}

  return {
    ...(activeEndpoint ? { activeEndpoint } : {}),
    ...(Object.keys(endpoints).length ? { endpoints } : {}),
    ...(Object.keys(serverMemories).length ? { serverMemories } : {}),
    ...(displayLines !== undefined ? { displayLines } : {}),
    ...(readMaxLines !== undefined ? { readMaxLines } : {}),
    ...(readMaxBytes !== undefined ? { readMaxBytes } : {}),
    ...(execMaxLines !== undefined ? { execMaxLines } : {}),
    ...(execMaxBytes !== undefined ? { execMaxBytes } : {}),
    ...(turnMaxBytes !== undefined ? { turnMaxBytes } : {}),
  };
}

function loadRemoteConfig(): RemoteConfig {
  try { return normalizeRemoteConfig(JSON.parse(readFileSync(REMOTE_CONFIG_FILE, "utf8"))); }
  catch { return {}; }
}

function saveRemoteConfig(config: RemoteConfig): void {
  mkdirSync(dirname(REMOTE_CONFIG_FILE), { recursive: true });
  writeFileSync(REMOTE_CONFIG_FILE, JSON.stringify(normalizeRemoteConfig(config), null, 2) + "\n", { mode: 0o600 });
}

function endpointConfig(config: RemoteConfig, command: string): RemoteEndpointConfig {
  try { return config.endpoints?.[cacheId(parseSshCommand(command))] ?? {}; }
  catch { return {}; }
}

function activeEndpointConfig(config: RemoteConfig): RemoteEndpointConfig | undefined {
  return config.activeEndpoint ? config.endpoints?.[config.activeEndpoint] : undefined;
}

function activeSshCommand(config = loadRemoteConfig()): string | undefined {
  return activeEndpointConfig(config)?.sshCommand;
}

function endpointDisplayLabel(endpoint: ParsedSsh, config = loadRemoteConfig()): string {
  const note = endpointConfig(config, endpoint.command).note?.trim();
  return note ? `${note} (${endpoint.label})` : endpoint.label;
}

function serverMemoryFilePath(endpoint: ParsedSsh | string): string {
  const server = typeof endpoint === "string" ? endpoint : serverMemoryId(endpoint);
  return join(SERVER_MEMORY_DIR, `${Buffer.from(server, "utf8").toString("base64url")}.json`);
}

function legacyMemoryEntries(memory: string): ServerMemoryEntry[] {
  return memory
    .trim()
    .split(/\n\s*\n/)
    .map((content) => content.trim())
    .filter(Boolean)
    .map((content, index) => ({ id: `legacy-${String(index + 1).padStart(3, "0")}`, content }));
}

function writeServerMemoryFile(path: string, memory: ServerMemoryFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(memory, null, 2) + "\n", { mode: 0o600 });
}

function migrateLegacyServerMemoryFile(endpoint: ParsedSsh): string {
  const path = serverMemoryFilePath(endpoint);
  if (existsSync(path)) return path;
  const legacyServer = legacyServerMemoryId(endpoint);
  const legacyPath = serverMemoryFilePath(legacyServer);
  if (!existsSync(legacyPath)) return path;
  const legacy = JSON.parse(readFileSync(legacyPath, "utf8")) as Partial<ServerMemoryFile>;
  if (legacy.server !== legacyServer || !Array.isArray(legacy.entries)) {
    throw new Error(`legacy server-memory file ${legacyPath} has an invalid server or entries field`);
  }
  writeServerMemoryFile(path, { server: serverMemoryId(endpoint), entries: legacy.entries as ServerMemoryEntry[] });
  return path;
}

function migrateLegacyServerMemories(): void {
  const config = loadRemoteConfig();
  const legacy = config.serverMemories ?? {};
  if (!Object.keys(legacy).length) {
    mkdirSync(SERVER_MEMORY_DIR, { recursive: true });
    return;
  }

  const remaining = { ...legacy };
  let changed = false;
  for (const [server, content] of Object.entries(legacy)) {
    const path = serverMemoryFilePath(server);
    try {
      if (!existsSync(path)) {
        writeServerMemoryFile(path, { server, entries: legacyMemoryEntries(content) });
      }
      delete remaining[server];
      changed = true;
    } catch {}
  }
  if (changed) saveRemoteConfig({ ...config, serverMemories: remaining });
}

function ensureServerMemoryFile(endpoint: ParsedSsh): string {
  const path = migrateLegacyServerMemoryFile(endpoint);
  if (!existsSync(path)) writeServerMemoryFile(path, { server: serverMemoryId(endpoint), entries: [] });
  return path;
}

function loadServerMemory(endpoint: ParsedSsh): ServerMemoryFile | undefined {
  const path = migrateLegacyServerMemoryFile(endpoint);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ServerMemoryFile>;
  if (parsed.server !== serverMemoryId(endpoint) || !Array.isArray(parsed.entries)) {
    throw new Error("expected an object with the matching server and an entries array");
  }
  const ids = new Set<string>();
  const entries = parsed.entries.map((entry, index) => {
    if (!entry || typeof entry.id !== "string" || !entry.id.trim() || typeof entry.content !== "string" || !entry.content.trim()) {
      throw new Error(`entry ${index + 1} must contain non-empty string id and content fields`);
    }
    const id = entry.id.trim();
    if (ids.has(id)) throw new Error(`duplicate entry id: ${id}`);
    ids.add(id);
    return { id, content: entry.content.trim() };
  });
  return { server: parsed.server, entries };
}

function formatServerMemoryEntries(memory: ServerMemoryFile | undefined): string {
  if (!memory?.entries.length) return "No entries.";
  return memory.entries.map((entry) => `[${entry.id}]\n${entry.content}`).join("\n\n");
}

function memoryManagementPrompt(remote: RemoteState): string {
  let path = serverMemoryFilePath(remote);
  try { path = ensureServerMemoryFile(remote); }
  catch {}
  return `Persistent memory for this SSH server is a local JSON file at ${path}. This exact path is always handled by Pi's local read, write, and edit tools even while other tools are routed over SSH. The file schema is {"server":"${serverMemoryId(remote)}","entries":[{"id":"stable-unique-id","content":"memory text"}]}. If the file does not exist, create it with that server value and an empty entries array. Read the file before changing it and preserve valid JSON plus all unrelated entries. Add by appending one object with a unique stable id; query by reading the file; update by editing only the matching id. DELETE SAFETY: delete an entry only when the user explicitly asks to delete, remove, or forget server memory. Before deleting, read the file and identify the exact id; if the target is ambiguous, ask the user. Use edit to remove only that exact object and preserve every other entry. Never treat a correction or replacement request as permission to delete, and never delete all entries unless the user explicitly requests deletion of all server memory.`;
}

function remoteSystemPrompt(systemPrompt: string, localCwd: string, remote: RemoteState): string {
  const workspacePrompt = systemPrompt.replace(
    `Current working directory: ${localCwd}`,
    `Current working directory: ${remote.cwd} (via SSH ${endpointDisplayLabel(remote)}). All read, write, edit, bash, and user shell operations run on this remote server, except for the explicitly identified local server-memory JSON file. Use remote with action disconnect to return to the local environment when requested.`,
  );
  return `${workspacePrompt}\n\n${memoryManagementPrompt(remote)}`;
}

function serverMemoryContext(remote: RemoteState): string | undefined {
  const path = serverMemoryFilePath(remote);
  let memory: ServerMemoryFile | undefined;
  try { memory = loadServerMemory(remote); }
  catch (error) {
    return `<ssh_remote_server_memory endpoint="${remote.label}" path="${path}">\nThe server-memory JSON file is invalid and must not be applied until repaired: ${(error as Error).message}\n</ssh_remote_server_memory>`;
  }
  if (!memory?.entries.length) return undefined;
  return `<ssh_remote_server_memory endpoint="${remote.label}" path="${path}">\nThe following user-configured JSON entries are persistent memory specific to this SSH server. Apply their content while working on this server:\n${JSON.stringify(memory.entries, null, 2)}\n</ssh_remote_server_memory>`;
}

function saveEndpointConfig(command: string, updates: RemoteEndpointConfig, makeActive = false): void {
  const config = loadRemoteConfig();
  const key = cacheId(parseSshCommand(command));
  saveRemoteConfig({
    ...config,
    ...(makeActive ? { activeEndpoint: key } : {}),
    endpoints: {
      ...(config.endpoints ?? {}),
      [key]: { ...endpointConfig(config, command), sshCommand: command, ...updates },
    },
  });
}


function loadKnownHosts(): Record<string, string> {
  try { return JSON.parse(readFileSync(KNOWN_HOSTS_FILE, "utf8")); }
  catch { return {}; }
}

function saveKnownHost(key: string, fingerprint: string): void {
  const hosts = loadKnownHosts();
  hosts[key] = fingerprint;
  mkdirSync(dirname(KNOWN_HOSTS_FILE), { recursive: true });
  writeFileSync(KNOWN_HOSTS_FILE, JSON.stringify(hosts, null, 2) + "\n", { mode: 0o600 });
}

function legacyHostTrustId(config: ParsedSsh): string {
  return `${config.host}:${config.port}`;
}

function trustedFingerprint(config: ParsedSsh): string | undefined {
  const hosts = loadKnownHosts();
  return hosts[cacheId(config)] ?? hosts[legacyHostTrustId(config)];
}

function displayFingerprint(hex: string): string {
  return `SHA256:${Buffer.from(hex, "hex").toString("base64").replace(/=+$/, "")}`;
}

function runtimeOutputDir(): string {
  if (runtimeCache.outputDir && existsSync(runtimeCache.outputDir)) return runtimeCache.outputDir;
  runtimeCache.outputDir = mkdtempSync(join(tmpdir(), "pi-ssh-remote-output-"));
  chmodSync(runtimeCache.outputDir, 0o700);
  return runtimeCache.outputDir;
}

function deleteOutput(path: string): void {
  try { rmSync(path, { force: true }); } catch {}
}

function cleanupRuntimeOutputs(): void {
  for (const path of runtimeCache.artifacts.values()) deleteOutput(path);
  runtimeCache.artifacts.clear();
  if (runtimeCache.outputDir) {
    try { rmSync(runtimeCache.outputDir, { recursive: true, force: true }); } catch {}
    runtimeCache.outputDir = undefined;
  }
}

function createOutputFile(): { path: string; fd: number } {
  const path = join(runtimeOutputDir(), `${randomUUID()}.log`);
  return { path, fd: openSync(path, "wx", 0o600) };
}

function saveOutput(output: string): string {
  const file = createOutputFile();
  try { writeSync(file.fd, output); }
  finally { closeSync(file.fd); }
  return file.path;
}

function trimRuntimeMap<T>(values: Map<string, T>): void {
  while (values.size > MAX_RUNTIME_ENTRIES) values.delete(values.keys().next().value!);
}

function registerArtifact(path: string): string {
  const ref = `out_${randomUUID().slice(0, 8)}`;
  runtimeCache.artifacts.set(ref, path);
  while (runtimeCache.artifacts.size > MAX_RUNTIME_ENTRIES) {
    const oldest = runtimeCache.artifacts.entries().next().value as [string, string] | undefined;
    if (!oldest) break;
    runtimeCache.artifacts.delete(oldest[0]);
    deleteOutput(oldest[1]);
  }
  return ref;
}

function outputDelta(previous: string, current: string): string {
  if (previous === current) return "";
  if (current.startsWith(previous)) return current.slice(previous.length).replace(/^\r?\n/, "");
  const before = previous.replace(/\r?\n$/, "").split(/\r?\n/);
  const after = current.replace(/\r?\n$/, "").split(/\r?\n/);
  for (let overlap = Math.min(before.length, after.length); overlap > 0; overlap--) {
    let matches = true;
    for (let index = 0; index < overlap; index++) {
      if (before[before.length - overlap + index] !== after[index]) { matches = false; break; }
    }
    if (matches) return after.slice(overlap).join("\n");
  }
  return current;
}

function validateEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("env must be an object of string values");
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    if (typeof item !== "string") throw new Error(`Environment value for ${key} must be a string`);
    env[key] = item;
  }
  return env;
}

function structuredRemoteCommand(command: string, envValue: unknown, groupValue: unknown): string {
  const env = validateEnvironment(envValue);
  let result = command;
  if (Object.keys(env).length) {
    const assignments = Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(" ");
    result = `env ${assignments} bash -lc ${quote(result)}`;
  }
  if (groupValue !== undefined) {
    if (typeof groupValue !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(groupValue)) {
      throw new Error("group must be a valid Unix group name");
    }
    result = `sg ${quote(groupValue)} -c ${quote(result)}`;
  }
  return result;
}

function validateSessionName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("session may contain only letters, digits, dot, underscore, and hyphen");
  }
  return value;
}

function changedStatus(previous: Record<string, unknown> | undefined, current: Record<string, unknown>): Record<string, unknown> {
  if (!previous) return current;
  const changed: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(current[key])) changed[key] = current[key] ?? null;
  }
  return changed;
}

class RemoteExecAccumulator {
  private chunks: Buffer[] = [];
  private tail = Buffer.alloc(0);
  private outputFile: { path: string; fd: number } | undefined;
  private totalBytes = 0;
  private newlineCount = 0;
  private lastByte: number | undefined;

  constructor(private maxLines: number, private maxBytes: number) {}

  append(chunk: Buffer): void {
    if (!chunk.length) return;
    this.totalBytes += chunk.length;
    for (const byte of chunk) if (byte === 10) this.newlineCount++;
    this.lastByte = chunk[chunk.length - 1];

    if (!this.outputFile && this.totalBytes > this.maxBytes) {
      this.outputFile = createOutputFile();
      for (const previous of this.chunks) writeSync(this.outputFile.fd, previous);
      this.chunks = [];
    }
    if (this.outputFile) writeSync(this.outputFile.fd, chunk);
    else this.chunks.push(chunk);

    this.tail = Buffer.concat([this.tail, chunk]);
    const tailBytes = this.maxBytes + OUTPUT_FOOTER_RESERVE_BYTES + 4096;
    if (this.tail.length > tailBytes) this.tail = this.tail.subarray(this.tail.length - tailBytes);
  }

  appendStderr(chunk: Buffer): void {
    this.append(chunk);
  }

  private ensureOutputFile(): string {
    if (!this.outputFile) {
      this.outputFile = createOutputFile();
      for (const chunk of this.chunks) writeSync(this.outputFile.fd, chunk);
      this.chunks = [];
    }
    return this.outputFile.path;
  }

  finish(exitCode = 0) {
    const totalLines = this.totalBytes ? this.newlineCount + (this.lastByte === 10 ? 0 : 1) : 0;
    const source = this.outputFile ? this.tail.toString("utf8") : Buffer.concat(this.chunks).toString("utf8");
    const contentBudget = Math.max(1, this.maxBytes - OUTPUT_FOOTER_RESERVE_BYTES);
    const base = truncateTail(source, { maxLines: this.maxLines, maxBytes: contentBudget });
    const truncated = this.totalBytes > contentBudget || totalLines > this.maxLines || base.truncated;
    const truncation = {
      ...base,
      truncated,
      totalLines,
      totalBytes: this.totalBytes,
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    };
    const content = base.content || "Remote command completed.";
    let fullOutputPath: string | undefined;
    let text = content;
    if (truncated) {
      fullOutputPath = this.ensureOutputFile();
      const startLine = Math.max(1, totalLines - base.outputLines + 1);
      text += `\n\n[Showing lines ${startLine}-${totalLines} of ${totalLines} (${formatSize(this.maxBytes)} model-output limit). Full output: ${fullOutputPath}]`;
    }
    this.close();
    return { exitCode, text, content, truncation, fullOutputPath };
  }

  close(): void {
    if (!this.outputFile) return;
    const file = this.outputFile;
    this.outputFile = undefined;
    closeSync(file.fd);
  }

  discard(): void {
    const path = this.outputFile?.path;
    this.close();
    if (path) deleteOutput(path);
  }
}

function previewRemoteOutput(output: string, displayLines: number): string {
  return truncateTail(output, { maxLines: displayLines, maxBytes: DEFAULT_MAX_BYTES }).content || "Remote command completed.";
}

function renderRemoteControlCall(args: any, theme: any): Component {
  const action = typeof args?.action === "string" ? args.action : "status";
  const context = [
    args?.cwd ? `cwd=${args.cwd}` : undefined,
    args?.endpoints?.length ? `endpoints=${args.endpoints.join(",")}` : undefined,
    args?.group ? `group=${args.group}` : undefined,
    args?.session ? `session=${args.session}` : undefined,
    args?.background && !args?.session ? "background" : undefined,
    args?.log ? `log=${args.log}` : undefined,
    args?.timeout ? `timeout=${args.timeout}s` : undefined,
    args?.env && Object.keys(args.env).length ? `env=${Object.keys(args.env).join(",")}` : undefined,
  ].filter(Boolean).join(" ");
  const detail = action === "exec" || action === "fanout"
    ? args?.remoteCommand ? `$ ${args.remoteCommand}` : undefined
    : action === "connect" || action === "note" || action === "memory"
      ? args?.command
      : action === "chdir"
        ? args?.cwd
        : action === "forward"
          ? args?.forwards
          : action === "artifact"
            ? args?.artifactRef
            : action === "job_status"
              ? args?.jobId
              : undefined;
  const title = theme.fg("toolTitle", theme.bold(`remote ${action}`));
  const metadata = context ? ` ${theme.fg("muted", context)}` : "";
  return new Text(`${title}${metadata}${detail ? `\n${theme.fg("toolOutput", detail)}` : ""}`, 0, 0);
}

function renderRemoteControlResult(result: any, expanded: boolean, theme: any): Component {
  const fallback = result.content?.find((item: any) => item.type === "text")?.text ?? "";
  const details = result.details;
  if (details?.action !== "exec") return new Text(fallback, 0, 0);

  const output = details.output || fallback;
  const displayLines = details.displayLines || DEFAULT_DISPLAY_LINES;
  const warnings = [
    ...(details.artifactRef ? [`Artifact: ${details.artifactRef}`] : details.fullOutputPath ? [`Full output: ${details.fullOutputPath}`] : []),
    ...(details.truncation?.truncated ? [`Truncated: showing ${details.truncation.outputLines} of ${details.truncation.totalLines} lines`] : []),
  ];
  const warning = warnings.length ? warnings.join(". ") : undefined;

  if (expanded) {
    return new Text(`${output}${warning ? `\n${theme.fg("warning", `[${warning}]`)}` : ""}`, 0, 0);
  }

  return {
    render(width: number) {
      const styled = output.split("\n").map((line: string) => theme.fg("toolOutput", line)).join("\n");
      const visualLines = new Text(styled, 0, 0).render(width);
      const shown = visualLines.slice(-displayLines);
      const skipped = visualLines.length - shown.length;
      const hint = skipped > 0
        ? [theme.fg("muted", `... (${skipped} earlier lines, ${keyHint("app.tools.expand", "to expand")})`)]
        : [];
      const warningLine = warning && theme.fg("warning", truncateToWidth(`[${warning}]`, width, ""));
      return [...hint, ...shown, ...(warningLine ? [warningLine] : [])];
    },
    invalidate() {},
  };
}

function createSshProxy(config: ParsedSsh): SshProxy | undefined {
  if (!config.proxyJump) return undefined;
  const jumps = config.proxyJump.split(",").map((value) => value.trim()).filter(Boolean);
  if (!jumps.length) return undefined;

  // OpenSSH owns the jump-host authentication and ProxyJump chain. ssh2 then
  // speaks the final SSH protocol over the resulting raw socket.
  const destination = jumps.at(-1)!;
  const args = [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ConnectionAttempts=1",
    "-o", "ExitOnForwardFailure=yes",
    "-W", `${config.host}:${config.port}`,
  ];
  if (jumps.length > 1) args.push("-J", jumps.slice(0, -1).join(","));
  args.push(destination);
  const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let closed = false;
  const socket = new Duplex({
    read() { child.stdout.resume(); },
    write(chunk, _encoding, callback) {
      if (child.stdin.destroyed) {
        callback(new Error("SSH ProxyJump stdin is closed"));
        return;
      }
      child.stdin.write(chunk, callback);
    },
  });
  const proxyError = (error: Error) => {
    if (!socket.destroyed) socket.destroy(error);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    if (!socket.push(chunk)) child.stdout.pause();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4096);
  });
  child.stdin.on("error", proxyError);
  child.stdout.on("error", proxyError);
  child.on("error", proxyError);
  child.on("exit", (code, signal) => {
    if (closed || socket.destroyed) return;
    if (code !== 0) {
      const detail = stderr.trim();
      socket.destroy(new Error(`SSH ProxyJump failed${detail ? `: ${detail}` : ` with exit code ${code ?? signal}`}`));
    } else {
      socket.push(null);
    }
  });
  socket.once("close", () => {
    if (closed) return;
    closed = true;
    if (!child.killed) child.kill();
  });
  const close = () => {
    if (closed) return;
    closed = true;
    socket.destroy();
    if (!child.killed) child.kill();
  };
  return { socket, close };
}

function probeFingerprint(config: ParsedSsh): Promise<string> {
  const proxy = createSshProxy(config);
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; client.end(); proxy?.close(); reject(new Error("Connection timed out")); }
    }, 10000);
    client.on("error", (error) => {
      if (!settled) { settled = true; clearTimeout(timer); proxy?.close(); reject(error); }
    });
    client.once("close", () => proxy?.close());
    client.connect({
      ...(proxy ? { sock: proxy.socket } : { host: config.host, port: config.port }),
      username: config.username,
      readyTimeout: 8000,
      hostHash: "sha256",
      hostVerifier: (hash) => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(hash); }
        setImmediate(() => client.end());
        return false;
      },
    });
  });
}

async function trustHostInteractive(config: ParsedSsh, ctx: any): Promise<void> {
  const key = cacheId(config);
  const hosts = loadKnownHosts();
  const routeFingerprint = hosts[key];
  const saved = routeFingerprint ?? hosts[legacyHostTrustId(config)];
  const fingerprint = await probeFingerprint(config);
  if (!saved) {
    const trusted = await ctx.ui.confirm("Trust SSH host", `${config.label}\nHost key: ${displayFingerprint(fingerprint)}\nTrust and save this key for this SSH route?`);
    if (!trusted) throw new Error("The host key was not trusted");
    saveKnownHost(key, fingerprint);
  } else if (saved !== fingerprint) {
    const trusted = await ctx.ui.confirm(
      "SSH host key changed",
      `${config.label}\nPrevious key: ${displayFingerprint(saved)}\nNew key: ${displayFingerprint(fingerprint)}\nVerify this SSH route. Update its saved key and continue?`,
    );
    if (!trusted) throw new Error("The changed host key was rejected");
    saveKnownHost(key, fingerprint);
  } else if (!routeFingerprint) {
    saveKnownHost(key, fingerprint);
  }
}

type SshAuthAttempt =
  | { type: "none"; username: string }
  | { type: "publickey"; username: string; key: Buffer; passphrase?: string }
  | { type: "agent"; username: string; agent: string }
  | { type: "password"; username: string; password: string };

interface SshAuthentication {
  authHandler: (methodsLeft: string[] | null, partialSuccess: boolean | null, callback: (attempt: SshAuthAttempt | false) => void) => void;
  preparationError: () => Error | undefined;
  passwordAvailable: () => boolean;
  passwordRejected: () => boolean;
  setPromptStateListener: (listener?: (active: boolean) => void) => void;
}

type SshConnectionError = Error & { level?: string; passwordAuthenticationFailed?: boolean };

function connect(config: ParsedSsh, authentication: SshAuthentication, fingerprint: string): Promise<SshClient> {
  const proxy = createSshProxy(config);
  return new Promise<SshClient>((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let remainingMs = SSH_CONNECT_TIMEOUT_MS;
    let timerStartedAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const pauseTimer = () => {
      if (!timer) return;
      remainingMs = Math.max(0, remainingMs - (Date.now() - timerStartedAt));
      clearTimeout(timer);
      timer = undefined;
    };
    const cleanup = () => {
      pauseTimer();
      authentication.setPromptStateListener();
    };
    const fail = (error: SshConnectionError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const resumeTimer = () => {
      if (settled || timer) return;
      timerStartedAt = Date.now();
      timer = setTimeout(() => {
        timer = undefined;
        remainingMs = 0;
        const error = new Error("Timed out while waiting for SSH handshake") as SshConnectionError;
        error.level = "client-timeout";
        fail(error);
        client.end();
      }, Math.max(1, remainingMs));
    };

    authentication.setPromptStateListener((active) => active ? pauseTimer() : resumeTimer());
    const options: ConnectConfig = {
      ...(proxy ? { sock: proxy.socket } : { host: config.host, port: config.port }),
      username: config.username,
      authHandler: authentication.authHandler,
      readyTimeout: 0,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      hostHash: "sha256",
      hostVerifier: (hash) => hash === fingerprint,
    };
    client.once("ready", () => {
      if (settled) return client.end();
      settled = true;
      cleanup();
      resolve(client);
    });
    client.once("close", () => {
      proxy?.close();
      fail(new Error("SSH connection closed before authentication completed"));
    });
    // ssh2 reports Agent and key-signing errors before continuing its own
    // authentication state machine. Keep the listener permanent, but reject
    // only terminal failures.
    client.on("error", (error: SshConnectionError) => {
      if (!isRecoverableAuthenticationError(error)) fail(error);
    });
    resumeTimer();
    try { client.connect(options); }
    catch (error) { fail(error as SshConnectionError); }
  }).catch((error: SshConnectionError) => {
    proxy?.close();
    const terminalAuthFailure = /all configured authentication methods failed/i.test(error.message);
    let failure = error;
    const preparationError = authentication.preparationError();
    if (preparationError && terminalAuthFailure) {
      failure = new Error(`${preparationError.message}; all configured authentication methods failed`) as SshConnectionError;
      failure.level = error.level;
    }
    if (shouldInvalidateCachedPassword(error, authentication.passwordRejected())) failure.passwordAuthenticationFailed = true;
    throw failure;
  });
}

function execRemote(
  client: SshClient,
  command: string,
  allowFailure = false,
  timeoutSeconds = DEFAULT_REMOTE_TIMEOUT_SECONDS,
): Promise<Buffer> {
  const resolvedTimeout = parseRemoteTimeout(timeoutSeconds);
  return new Promise((resolve, reject) => {
    client.exec(withRemoteTimeout(command, resolvedTimeout), (error, stream) => {
      if (error) return reject(error);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let locallyTimedOut = false;
      const timer = setTimeout(() => {
        locallyTimedOut = true;
        stream.close();
      }, (resolvedTimeout + 8) * 1000);
      const cleanup = () => clearTimeout(timer);
      stream.on("data", (chunk: Buffer) => stdout.push(chunk));
      stream.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      stream.once("error", (streamError: Error) => {
        cleanup();
        reject(streamError);
      });
      stream.on("close", (code: number | null) => {
        cleanup();
        if (locallyTimedOut || code === 124 || code === 137) reject(new Error(`Remote command timed out after ${resolvedTimeout} seconds`));
        else if (!allowFailure && code !== 0) reject(new Error(Buffer.concat(stderr).toString().trim() || `Remote command exited with code ${code}`));
        else resolve(Buffer.concat(stdout));
      });
    });
  });
}

function execRemoteLimited(
  client: SshClient,
  command: string,
  timeoutSeconds: number,
  maxLines: number,
  maxBytes: number,
): Promise<ReturnType<RemoteExecAccumulator["finish"]>> {
  const resolvedTimeout = parseRemoteTimeout(timeoutSeconds);
  return new Promise((resolve, reject) => {
    client.exec(withRemoteTimeout(command, resolvedTimeout), (error, stream) => {
      if (error) return reject(error);
      const accumulator = new RemoteExecAccumulator(maxLines, maxBytes);
      let locallyTimedOut = false;
      let settled = false;
      const timer = setTimeout(() => {
        locallyTimedOut = true;
        stream.close();
      }, (resolvedTimeout + 8) * 1000);
      const cleanup = () => clearTimeout(timer);
      const fail = (failure: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        accumulator.discard();
        reject(failure);
      };
      stream.on("data", (chunk: Buffer) => accumulator.append(chunk));
      stream.stderr.on("data", (chunk: Buffer) => accumulator.appendStderr(chunk));
      stream.once("error", (streamError: Error) => fail(streamError));
      stream.on("close", (code: number | null) => {
        if (settled) return;
        cleanup();
        if (locallyTimedOut || code === 124 || code === 137) {
          fail(new Error(`Remote command timed out after ${resolvedTimeout} seconds`));
          return;
        }
        settled = true;
        resolve(accumulator.finish(code ?? 255));
      });
    });
  });
}

function getSftp(client: SshClient): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)));
}

async function withSftp<T>(client: SshClient, operation: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const sftp = await getSftp(client);
  try { return await operation(sftp); }
  finally { sftp.end(); }
}

function isReconnectable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /channel open failure|open failed|not connected|no response|econnreset|econnrefused|etimedout|ehostunreach|epipe|connection (?:lost|closed)|socket.*closed|client is not connected/i.test(message);
}

class SecretInput implements Component, Focusable {
  focused = false;
  private value = "";
  constructor(private label: string, private done: (value: string | null) => void, private renderNow: () => void) {}
  handleInput(data: string): void {
    if (matchesKey(data, Key.enter)) return this.done(this.value);
    if (matchesKey(data, Key.escape)) return this.done(null);
    if (matchesKey(data, Key.backspace)) this.value = [...this.value].slice(0, -1).join("");
    else if (matchesKey(data, Key.ctrl("u"))) this.value = "";
    else {
      const clean = data.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
      if ([...clean].every((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)) this.value += clean;
    }
    this.renderNow();
  }
  render(width: number): string[] {
    return [truncateToWidth(`${this.label}: ${"•".repeat([...this.value].length)}${this.focused ? CURSOR_MARKER : ""}\x1b[7m \x1b[27m`, width, "")];
  }
  invalidate(): void {}
}

async function askSecret(ctx: any, label: string, placeholder: string): Promise<string | null> {
  if (ctx.mode !== "tui") return (await ctx.ui.input(`${label}:`, placeholder)) ?? null;
  return ctx.ui.custom<string | null>((tui: any, _theme: any, _keys: any, done: (value: string | null) => void) =>
    new SecretInput(label, done, () => tui.requestRender()));
}

async function askPassword(ctx: any): Promise<string | null> {
  return askSecret(ctx, "SSH password", "password");
}

export default function sshRemoteExtension(pi: ExtensionAPI) {
  migrateLegacyServerMemories();

  const localCwd = process.cwd();
  let remote: RemoteState | null = null;
  let routeRemoteTools = false;
  let currentCtx: any;
  let reconnectPromise: Promise<RemoteState> | null = null;
  let connectionGeneration = 0;
  let interactiveConnectGeneration: number | undefined;
  const forwardServers = new Map<number, Server>();
  const forwardSpecs = new Map<number, ForwardSpec>();
  const forwardSockets = new Map<Server, Set<Socket>>();
  let sessionReady = false;
  let restoringSessionState = false;
  let lastConnectionError: string | undefined;
  let lastCommand = credentialCache.resume?.command ?? activeSshCommand() ?? "";
  let turnOutputBytes = 0;

  const configuredCwd = (command: string): string =>
    endpointConfig(loadRemoteConfig(), command).remoteCwd || FALLBACK_REMOTE_CWD;

  const configuredForwards = (command: string): string[] =>
    endpointConfig(loadRemoteConfig(), command).forwards ?? [];

  const executionCwd = (state: ParsedSsh & { cwd: string }, requested?: string): string =>
    !requested ? state.cwd : requested.startsWith("/") ? posix.normalize(requested) : posix.resolve(state.cwd, requested);

  const updateOutputCursor = (
    state: ParsedSsh,
    command: string,
    cwd: string,
    output: string,
    truncated: boolean,
    sinceCursor?: string,
  ): { cursor?: string; output: string; discontinuity?: boolean } => {
    const endpoint = cacheId(state);
    if (sinceCursor) {
      const previous = runtimeCache.cursors.get(sinceCursor);
      if (!previous) throw new Error(`Unknown or expired output cursor: ${sinceCursor}`);
      if (previous.endpoint !== endpoint || previous.command !== command || previous.cwd !== cwd) {
        throw new Error("Output cursor belongs to a different endpoint, command, or working directory");
      }
      runtimeCache.cursors.delete(sinceCursor);
      if (truncated) return { output, discontinuity: true };
      const delta = outputDelta(previous.output, output);
      runtimeCache.cursors.set(sinceCursor, { endpoint, command, cwd, output });
      return { cursor: sinceCursor, output: delta };
    }
    if (truncated) return { output };
    const cursor = `cur_${randomUUID().slice(0, 8)}`;
    runtimeCache.cursors.set(cursor, { endpoint, command, cwd, output });
    trimRuntimeMap(runtimeCache.cursors);
    return { cursor, output };
  };

  const configuredEndpoint = (selector: string): { parsed: ParsedSsh; cwd: string } => {
    if (selector.trim().startsWith("ssh ")) {
      const parsed = parseSshCommand(selector.trim());
      return { parsed, cwd: configuredCwd(parsed.command) };
    }
    const config = loadRemoteConfig();
    const matches = Object.entries(config.endpoints ?? {}).flatMap(([key, endpoint]) => {
      const command = endpoint.sshCommand || commandFromEndpointKey(key);
      if (!command) return [];
      const parsed = parseSshCommand(command);
      return key === selector || parsed.label === selector || parsed.sshTarget === selector
        ? [{ parsed, cwd: endpoint.remoteCwd || FALLBACK_REMOTE_CWD }]
        : [];
    });
    if (matches.length !== 1) throw new Error(matches.length ? `Endpoint is ambiguous: ${selector}` : `Endpoint not found: ${selector}`);
    return matches[0]!;
  };

  const authentication = (parsed: ParsedSsh, password?: string, ctx?: any): SshAuthentication => {
    const steps = authenticationSteps({
      identityFiles: parsed.identityFiles,
      identitiesOnly: parsed.identitiesOnly,
      agent: resolveIdentityAgent(parsed.identityAgent, process.env.SSH_AUTH_SOCK),
      password,
    });
    let preparationError: Error | undefined;
    let passwordOffered = false;
    let passwordAttempted = false;
    let passwordAccepted = false;
    let promptStateListener: (active: boolean) => void = () => {};

    const prepareIdentity = async (identityFile: string): Promise<{ key: Buffer; passphrase?: string } | undefined> => {
      const explicit = identityFile === parsed.explicitIdentityFile;
      let keyData: Buffer;
      try { keyData = readPrivateKey(identityFile); }
      catch (error) {
        if (explicit) preparationError ??= error as Error;
        return undefined;
      }
      let passphrase = getCachedKeyPassphrase(parsed, identityFile);
      let privateKey = parsePrivateKey(keyData, passphrase);
      if (privateKey instanceof Error && isPassphraseError(privateKey)) {
        if (passphrase) {
          deleteCachedKeyPassphrase(parsed, identityFile);
          passphrase = undefined;
        }
        if (!ctx) {
          preparationError ??= new Error(`SSH private key ${resolveIdentityPath(identityFile)} requires its passphrase; reconnect interactively`);
          return undefined;
        }
        promptStateListener(true);
        try {
          passphrase = await askSecret(ctx, `Passphrase for ${identityFile}`, "private key passphrase") ?? undefined;
        } finally {
          promptStateListener(false);
        }
        if (!passphrase) {
          preparationError ??= new Error(`No passphrase was provided for SSH private key ${resolveIdentityPath(identityFile)}`);
          return undefined;
        }
        privateKey = parsePrivateKey(keyData, passphrase);
        if (privateKey instanceof Error) {
          deleteCachedKeyPassphrase(parsed, identityFile);
          preparationError ??= new Error(`Could not unlock SSH private key ${resolveIdentityPath(identityFile)}: ${privateKey.message}`);
          return undefined;
        }
        setCachedKeyPassphrase(parsed, identityFile, passphrase);
      }
      if (privateKey instanceof Error) {
        if (explicit) preparationError ??= new Error(`Invalid SSH private key ${resolveIdentityPath(identityFile)}: ${privateKey.message}`);
        return undefined;
      }
      return { key: keyData, ...(passphrase ? { passphrase } : {}) };
    };

    const authHandler = createAuthHandler({
      steps,
      username: parsed.username,
      prepareIdentity,
      onMethodsLeft: (methodsLeft: string[] | null) => { if (methodsLeft?.includes("password")) passwordOffered = true; },
      onAttempt: (attempt: SshAuthAttempt) => { if (attempt.type === "password") passwordAttempted = true; },
      onAccepted: (attempt: SshAuthAttempt) => { if (attempt.type === "password") passwordAccepted = true; },
      onError: (error: unknown) => { preparationError ??= error as Error; },
    }) as SshAuthentication["authHandler"];

    return {
      authHandler,
      preparationError: () => preparationError,
      passwordAvailable: () => passwordOffered,
      passwordRejected: () => passwordAttempted && !passwordAccepted,
      setPromptStateListener: (listener) => { promptStateListener = listener ?? (() => {}); },
    };
  };

  const cachedAuthentication = (parsed: ParsedSsh): SshAuthentication =>
    authentication(parsed, getCachedPassword(parsed));

  const mapPath = (path: string): string => {
    if (!remote) return path;
    if (path === localCwd) return remote.cwd;
    const prefix = localCwd.endsWith(sep) ? localCwd : localCwd + sep;
    if (path.startsWith(prefix)) return remote.cwd.replace(/\/$/, "") + "/" + relative(localCwd, path).split(sep).join("/");
    return path;
  };

  const remotePath = (path: string): string => {
    const normalized = path.replace(/^@/, "");
    if (normalized.startsWith("/")) return mapPath(normalized);
    if (!remote) return normalized;
    return posix.join(remote.cwd, normalized);
  };

  const serializeForward = (spec: ForwardSpec): string => `${spec.localPort}:${spec.remoteHost}:${spec.remotePort}`;

  const currentSessionRemoteState = (): SessionRemoteState => remote ? {
    version: 1,
    connected: true,
    command: remote.command,
    cwd: remote.cwd,
    routeRemoteTools,
    forwards: [...forwardSpecs.values()].map(serializeForward),
  } : { version: 1, connected: false };

  const persistSessionRemoteState = (): void => {
    if (!sessionReady || restoringSessionState) return;
    pi.appendEntry(SESSION_STATE_ENTRY_TYPE, currentSessionRemoteState());
  };

  const loadSessionRemoteState = (ctx: any): SessionRemoteState | undefined => {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index] as any;
      if (entry.type !== "custom" || entry.customType !== SESSION_STATE_ENTRY_TYPE) continue;
      const data = entry.data as Partial<SessionRemoteState> | undefined;
      if (!data || data.version !== 1 || typeof data.connected !== "boolean") return undefined;
      if (data.connected && (typeof data.command !== "string" || typeof data.cwd !== "string")) return undefined;
      return {
        version: 1,
        connected: data.connected,
        ...(data.command ? { command: data.command } : {}),
        ...(data.cwd ? { cwd: data.cwd } : {}),
        ...(typeof data.routeRemoteTools === "boolean" ? { routeRemoteTools: data.routeRemoteTools } : {}),
        ...(Array.isArray(data.forwards) ? { forwards: data.forwards.filter((value): value is string => typeof value === "string") } : {}),
      };
    }
    return undefined;
  };

  const limitRemoteToolResult = (
    result: any,
    kind: "read" | "exec",
    startLine = 1,
    requestedMaxLines?: number,
    requestedMaxBytes?: number,
  ) => {
    const limits = configuredOutputLimits();
    const configuredMaxBytes = kind === "read" ? limits.readMaxBytes : limits.execMaxBytes;
    const configuredMaxLines = kind === "read" ? limits.readMaxLines : limits.execMaxLines;
    const maxLines = requestedMaxLines ?? configuredMaxLines;
    const selectedMaxBytes = requestedMaxBytes ?? configuredMaxBytes;
    const remaining = Math.max(0, limits.turnMaxBytes - turnOutputBytes);
    if (remaining < MIN_MODEL_OUTPUT_BYTES) {
      const text = `[Remote tool output omitted because this turn has used its ${formatSize(limits.turnMaxBytes)} model-output budget. Run a narrower follow-up command.]`;
      turnOutputBytes += Buffer.byteLength(text, "utf8");
      return { ...result, content: [{ type: "text", text }], details: { ...(result.details ?? {}), turnBudgetExceeded: true } };
    }

    const maxBytes = Math.min(selectedMaxBytes, remaining);
    const textIndex = result.content?.findIndex((item: any) => item.type === "text") ?? -1;
    if (textIndex < 0) return result;
    const original = result.content[textIndex].text ?? "";
    const reserveBytes = result.details?.modelLimited ? 0 : OUTPUT_FOOTER_RESERVE_BYTES;
    const contentBudget = Math.max(1, maxBytes - reserveBytes);
    const truncation = kind === "read"
      ? truncateHead(original, { maxLines, maxBytes: contentBudget })
      : truncateTail(original, { maxLines, maxBytes: contentBudget });
    let text = truncation.content;
    let fullOutputPath = result.details?.fullOutputPath as string | undefined;
    let artifactRef = result.details?.artifactRef as string | undefined;
    if (truncation.firstLineExceedsLimit) {
      text = `[Line ${startLine} exceeds the ${formatSize(maxBytes)} remote read limit. Use bash with sed/head -c to inspect a bounded fragment.]`;
    } else if (truncation.truncated) {
      if (kind === "read") {
        const nextOffset = startLine + truncation.outputLines;
        text += `\n\n[Showing ${truncation.outputLines} lines (${formatSize(maxBytes)} remote read limit). Use offset=${nextOffset} to continue.]`;
      } else {
        fullOutputPath ??= saveOutput(original);
        artifactRef ??= registerArtifact(fullOutputPath);
        const tail = truncateTail(truncation.content, {
          maxLines: DEFAULT_LONG_OUTPUT_SUMMARY_LINES,
          maxBytes: Math.min(DEFAULT_LONG_OUTPUT_SUMMARY_BYTES, contentBudget),
        }).content;
        text = `output_truncated lines=${truncation.totalLines} bytes=${truncation.totalBytes} artifact_ref=${artifactRef}` +
          `${tail ? `\ntail:\n${tail}` : ""}`;
      }
    }
    const content = [...result.content];
    content[textIndex] = { ...content[textIndex], text: text || (kind === "exec" ? "Remote command completed." : "") };
    const actualBytes = Buffer.byteLength(content[textIndex].text, "utf8");
    turnOutputBytes += actualBytes;
    return {
      ...result,
      content,
      details: {
        ...(result.details ?? {}),
        ...(truncation.truncated ? { truncation } : {}),
        ...(fullOutputPath ? { fullOutputPath } : {}),
        ...(artifactRef ? { artifactRef } : {}),
      },
    };
  };

  const status = (ctx: any) => {
    currentCtx = ctx;
    if (!remote) ctx.ui.setStatus("ssh-remote", undefined);
    else if (routeRemoteTools) ctx.ui.setStatus("ssh-remote", ctx.ui.theme.fg("accent", `${endpointDisplayLabel(remote)}:${remote.cwd}`));
    else ctx.ui.setStatus("ssh-remote", ctx.ui.theme.fg("accent", `tunnel ${[...forwardServers.keys()].join(",") || endpointDisplayLabel(remote)}`));
  };

  const attachClient = (state: RemoteState) => {
    const { client } = state;
    client.on("close", () => {
      if (remote?.client !== client || interactiveConnectGeneration !== undefined) return;
      if (currentCtx) {
        currentCtx.ui.setStatus("ssh-remote", currentCtx.ui.theme.fg("warning", `reconnecting ${endpointDisplayLabel(state)}…`));
      }
      void reconnectRemote().catch((error) => {
        if (currentCtx) currentCtx.ui.notify(`SSH remote automatic reconnection failed: ${(error as Error).message}`, "error");
      });
    });
  };

  const establish = async (parsed: ParsedSsh, authentication: SshAuthentication, cwd: string): Promise<RemoteState> => {
    const key = cacheId(parsed);
    const routeTrusted = loadKnownHosts()[key];
    const fingerprint = routeTrusted ?? trustedFingerprint(parsed);
    if (!fingerprint) throw new Error(`SSH route ${parsed.label} is not trusted; connect interactively with /remote first`);
    const client = await connect(parsed, authentication, fingerprint);
    try {
      if (!routeTrusted) saveKnownHost(key, fingerprint);
      const cdCommand = cwd === FALLBACK_REMOTE_CWD ? "cd -- ~" : `cd -- ${quote(cwd)}`;
      const resolved = (await execRemote(client, `${cdCommand} && pwd -P`)).toString().trim();
      const state = { ...parsed, client, cwd: resolved };
      attachClient(state);
      return state;
    } catch (error) {
      client.end();
      throw error;
    }
  };

  async function reconnectRemote(): Promise<RemoteState> {
    if (reconnectPromise) return reconnectPromise;
    const generation = connectionGeneration;
    const resumeRouting = remote ? routeRemoteTools : (credentialCache.resume?.routeRemoteTools ?? true);
    const source = remote ?? (credentialCache.resume ? { ...parseSshCommand(credentialCache.resume.command), cwd: credentialCache.resume.cwd } : null);
    if (!source) throw new Error("No SSH remote connection is available to reconnect");
    const parsed = parseSshCommand(source.command);
    const password = getCachedPassword(parsed);
    const pending = (async () => {
      const oldClient = remote?.client;
      const next = await establish(parsed, authentication(parsed, password), source.cwd);
      if (generation !== connectionGeneration) {
        next.client.end();
        throw new Error("SSH reconnection was superseded by another workspace action");
      }
      remote = next;
      routeRemoteTools = resumeRouting;
      credentialCache.resume = { command: parsed.command, cwd: next.cwd, routeRemoteTools, forwards: credentialCache.resume?.forwards };
      oldClient?.end();
      if (currentCtx) {
        status(currentCtx);
        currentCtx.ui.notify(`SSH remote reconnected automatically: ${endpointDisplayLabel(next)}:${next.cwd}`, "info");
      }
      return next;
    })();
    reconnectPromise = pending;
    const clearPending = () => { if (reconnectPromise === pending) reconnectPromise = null; };
    void pending.then(clearPending, clearPending);
    return pending;
  }

  const withReconnect = async <T>(operation: (client: SshClient) => Promise<T>): Promise<T> => {
    if (!remote) throw new Error("SSH remote is not connected");
    try { return await operation(remote.client); }
    catch (error) {
      if (!isReconnectable(error)) throw error;
      const state = await reconnectRemote();
      return operation(state.client);
    }
  };

  const changeRemoteCwd = async (requested: string, ctx: any): Promise<string> => {
    if (!remote) throw new Error("SSH remote is not connected");
    const target = requested.trim() || FALLBACK_REMOTE_CWD;
    const targetCommand = target === FALLBACK_REMOTE_CWD ? "cd -- ~" : `cd -- ${quote(target)}`;
    const resolved = (await withReconnect((client) => execRemote(
      client,
      `cd -- ${quote(remote!.cwd)} && ${targetCommand} && pwd -P`,
    ))).toString().trim();
    remote.cwd = resolved;
    credentialCache.resume = { command: remote.command, cwd: resolved, routeRemoteTools, forwards: [...forwardSpecs.values()].map(serializeForward) };
    saveEndpointConfig(remote.command, { remoteCwd: resolved }, true);
    status(ctx);
    persistSessionRemoteState();
    return resolved;
  };

  const standaloneCdTarget = (command: string): string | undefined => {
    try {
      const words = shellWords(command);
      if (words[0] !== "cd" || words.length > 3) return undefined;
      if (words.length === 3 && words[1] !== "--") return undefined;
      return words.at(-1) === "cd" || words.at(-1) === "--" ? FALLBACK_REMOTE_CWD : words.at(-1);
    } catch {
      return undefined;
    }
  };

  const connectInteractive = async (command: string, ctx: any, cwd?: string): Promise<RemoteState | null> => {
    let parsed: ParsedSsh;
    try { parsed = parseSshCommand(command); }
    catch (error) {
      lastConnectionError = (error as Error).message;
      ctx.ui.notify(lastConnectionError, "error");
      return null;
    }
    lastConnectionError = undefined;

    try { await trustHostInteractive(parsed, ctx); }
    catch (error) {
      lastConnectionError = (error as Error).message;
      return null;
    }

    const previous = remote;
    const previousRouting = routeRemoteTools;
    const generation = ++connectionGeneration;
    interactiveConnectGeneration = generation;
    let password = getCachedPassword(parsed);
    ctx.ui.setStatus("ssh-remote", ctx.ui.theme.fg("warning", `connecting ${endpointDisplayLabel(parsed)}…`));
    try {
      let next: RemoteState;
      const initialAuthentication = authentication(parsed, password, ctx);
      try {
        next = await establish(parsed, initialAuthentication, cwd ?? configuredCwd(command));
      } catch (error) {
        if (!shouldPromptForPassword(error, initialAuthentication.passwordAvailable())) throw error;
        if ((error as SshConnectionError).passwordAuthenticationFailed) deleteCachedPassword(parsed);
        password = await askPassword(ctx) ?? undefined;
        if (!password) throw new Error("No SSH password was provided after key and Agent authentication failed");
        next = await establish(parsed, authentication(parsed, password, ctx), cwd ?? configuredCwd(command));
      }
      if (generation !== connectionGeneration) {
        next.client.end();
        throw new Error("SSH connection attempt was superseded by another workspace action");
      }
      if (previous && cacheId(previous) !== cacheId(next)) await stopForwards();
      if (generation !== connectionGeneration) {
        next.client.end();
        throw new Error("SSH connection attempt was superseded by another workspace action");
      }
      remote = next;
      routeRemoteTools = true;
      previous?.client.end();
      if (password) setCachedPassword(parsed, password);
      credentialCache.resume = {
        command,
        cwd: next.cwd,
        routeRemoteTools,
        forwards: [...forwardSpecs.values()].map(serializeForward),
      };
      lastCommand = command;
      lastConnectionError = undefined;
      saveEndpointConfig(command, { remoteCwd: next.cwd }, true);
      status(ctx);
      persistSessionRemoteState();
      ctx.ui.notify(`SSH remote connected: ${endpointDisplayLabel(next)}:${next.cwd}`, "info");
      return next;
    } catch (error) {
      if (generation === connectionGeneration) {
        if ((error as SshConnectionError).passwordAuthenticationFailed) deleteCachedPassword(parsed);
        remote = previous;
        routeRemoteTools = previous ? previousRouting : false;
        lastConnectionError = (error as Error).message;
        status(ctx);
        ctx.ui.notify(`SSH remote connection failed: ${lastConnectionError}`, "error");
      }
      return null;
    } finally {
      if (interactiveConnectGeneration === generation) interactiveConnectGeneration = undefined;
    }
  };

  const ensureConnected = async (ctx: any): Promise<RemoteState> => {
    if (remote) return remote;
    if (credentialCache.resume) return reconnectRemote();
    const command = lastCommand || activeSshCommand();
    if (!command) throw new Error("No SSH endpoint configured; use /remote ssh USER@HOST -p PORT [-i KEY]");
    const state = await connectInteractive(command, ctx, configuredCwd(command));
    if (!state) throw new Error("SSH remote connection was cancelled or failed");
    return state;
  };

  const startForward = async (spec: ForwardSpec): Promise<boolean> => {
    const existing = forwardSpecs.get(spec.localPort);
    if (existing) {
      if (serializeForward(existing) === serializeForward(spec)) return false;
      throw new Error(`Local port ${spec.localPort} is already forwarded to ${existing.remoteHost}:${existing.remotePort}`);
    }
    const server = createServer((socket: Socket) => {
      const sockets = forwardSockets.get(server);
      sockets?.add(socket);
      socket.once("close", () => sockets?.delete(socket));
      void withReconnect((client) => new Promise<ClientChannel>((resolve, reject) =>
        client.forwardOut("127.0.0.1", 0, spec.remoteHost, spec.remotePort, (error, stream) =>
          error ? reject(error) : resolve(stream)))).then((stream) => {
            socket.on("error", () => stream.close());
            stream.on("error", () => socket.destroy());
            socket.pipe(stream).pipe(socket);
          }, () => socket.destroy());
    });
    forwardSockets.set(server, new Set());
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(spec.localPort, "127.0.0.1", () => {
          server.off("error", onError);
          server.on("error", () => {});
          resolve();
        });
      });
    } catch (error) {
      forwardSockets.delete(server);
      throw error;
    }
    forwardServers.set(spec.localPort, server);
    forwardSpecs.set(spec.localPort, spec);
    return true;
  };

  const stopForwards = async (ports = [...forwardServers.keys()]): Promise<void> => {
    const servers = ports.flatMap((port) => {
      const server = forwardServers.get(port);
      if (!server) return [];
      forwardServers.delete(port);
      forwardSpecs.delete(port);
      return [server];
    });
    await Promise.all(servers.map((server) => new Promise<void>((done) => {
      server.close(() => done());
      for (const socket of forwardSockets.get(server) ?? []) socket.destroy();
      server.closeAllConnections?.();
      forwardSockets.delete(server);
    })));
  };

  const startForwards = async (specs: ForwardSpec[]): Promise<void> => {
    const started: number[] = [];
    try {
      for (const spec of specs) if (await startForward(spec)) started.push(spec.localPort);
    } catch (error) {
      await stopForwards(started);
      throw error;
    }
  };

  const restoreSessionRemoteState = async (saved: SessionRemoteState, ctx: any): Promise<void> => {
    if (!saved.connected) {
      credentialCache.resume = undefined;
      status(ctx);
      return;
    }
    const command = saved.command!;
    const next = await connectInteractive(command, ctx, saved.cwd);
    if (!next) throw new Error(lastConnectionError || "SSH remote session restore was cancelled or failed");
    routeRemoteTools = saved.routeRemoteTools ?? true;
    const specs = (saved.forwards ?? []).map(parseForwardSpec);
    await startForwards(specs);
    credentialCache.resume = { command, cwd: next.cwd, routeRemoteTools, forwards: [...forwardSpecs.values()].map(serializeForward) };
    status(ctx);
  };

  const disconnect = async (ctx: any, forgetCredentials = false): Promise<void> => {
    connectionGeneration++;
    const previous = remote;
    remote = null;
    routeRemoteTools = false;
    reconnectPromise = null;
    credentialCache.resume = undefined;
    await stopForwards();
    if (forgetCredentials) {
      const configured = previous ?? (() => {
        const command = activeSshCommand();
        if (!command) return undefined;
        try { return parseSshCommand(command); } catch { return undefined; }
      })();
      if (configured) {
        deleteCachedPassword(configured);
        deleteCachedKeyPassphrase(configured);
      }
    }
    previous?.client.end();
    status(ctx);
    persistSessionRemoteState();
    ctx.ui.notify(forgetCredentials ? "SSH remote disconnected and cached credentials cleared" : "SSH remote mode disabled (credentials remain cached in memory only)", "info");
  };

  const detectRemoteMimeType = async (path: string): Promise<string | undefined> => {
    try {
      return (await withReconnect((client) => execRemote(client, `file --mime-type -b -- ${quote(remotePath(path))}`))).toString().trim() || undefined;
    } catch { return undefined; }
  };

  const isTextMimeType = (mime: string): boolean =>
    mime.startsWith("text/") || /\/(?:json|ld\+json|xml|javascript|x-sh|x-shellscript|x-empty)$/.test(mime);

  const remoteReadOps = (): ReadOperations => ({
    readFile: (path) => withReconnect((client) => withSftp(client, (sftp) =>
      new Promise<Buffer>((resolve, reject) => sftp.readFile(mapPath(path), (error, data) => error ? reject(error) : resolve(data))))),
    access: (path) => withReconnect((client) => withSftp(client, (sftp) =>
      new Promise<void>((resolve, reject) => sftp.stat(mapPath(path), (error) => error ? reject(error) : resolve())))),
    detectImageMimeType: async (path) => {
      const mime = await detectRemoteMimeType(path);
      return mime && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : null;
    },
  });

  const executeRemoteRead = async (id: string, params: any, signal: AbortSignal | undefined, update: any) => {
    if (signal?.aborted) throw new Error("aborted");
    const path = remotePath(params.path);
    await withReconnect((client) => withSftp(client, (sftp) =>
      new Promise<void>((resolve, reject) => sftp.stat(path, (error) => error ? reject(error) : resolve()))));
    const mime = await detectRemoteMimeType(path);
    if (mime && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime)) {
      const result = await createReadTool(localCwd, { operations: remoteReadOps() }).execute(id, params, signal, update);
      return limitRemoteToolResult(result, "read", params.offset ?? 1);
    }
    if (mime && !isTextMimeType(mime)) throw new Error(`Refusing to read remote binary file as text (${mime}): ${params.path}`);

    const limits = configuredOutputLimits();
    const startLine = Math.max(1, Math.floor(Number(params.offset ?? 1)));
    const requestedLines = Math.max(1, Math.floor(Number(params.limit ?? limits.readMaxLines)));
    const linesToFetch = Math.min(requestedLines, limits.readMaxLines) + 1;
    const endLine = startLine + linesToFetch - 1;
    const transferBytes = Math.min(DEFAULT_MAX_BYTES, limits.readMaxBytes + OUTPUT_FOOTER_RESERVE_BYTES + 4096);
    const command = `sed -n '${startLine},${endLine}p' ${quote(path)} | head -c ${transferBytes}`;
    const output = await withReconnect((client) => execRemote(client, command, false, DEFAULT_REMOTE_TIMEOUT_SECONDS));
    if (signal?.aborted) throw new Error("aborted");
    if (!output.length && startLine > 1) throw new Error(`Offset ${startLine} is beyond end of remote file`);
    const result = {
      content: [{ type: "text", text: output.toString("utf8") }],
      details: { remoteRange: { path, startLine, requestedLines: Math.min(requestedLines, limits.readMaxLines) } },
    };
    return limitRemoteToolResult(result, "read", startLine, Math.min(requestedLines, limits.readMaxLines));
  };

  const remoteWriteOps = (): WriteOperations => ({
    writeFile: (path, content) => withReconnect((client) => withSftp(client, (sftp) =>
      new Promise<void>((resolve, reject) => sftp.writeFile(mapPath(path), content, (error) => error ? reject(error) : resolve())))),
    mkdir: async (path) => { await withReconnect((client) => execRemote(client, `mkdir -p -- ${quote(mapPath(path))}`)); },
  });

  const remoteEditOps = (): EditOperations => {
    const read = remoteReadOps();
    const write = remoteWriteOps();
    return { readFile: read.readFile, access: read.access, writeFile: write.writeFile };
  };

  const openExecChannel = async (command: string): Promise<ClientChannel> =>
    withReconnect((client) => new Promise<ClientChannel>((resolve, reject) =>
      client.exec(command, (error, stream) => error ? reject(error) : resolve(stream))));

  const remoteBashOps = (): BashOperations => ({
    exec: (command, cwd, { onData, signal, timeout }) => new Promise((resolve, reject) => {
      const timeoutSeconds = parseRemoteTimeout(timeout ?? DEFAULT_REMOTE_TIMEOUT_SECONDS);
      const remoteCommand = withRemoteTimeout(command, timeoutSeconds);
      const full = `cd -- ${quote(mapPath(cwd))} && ${remoteCommand}`;
      void openExecChannel(full).then((stream) => {
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; stream.close(); }, (timeoutSeconds + 8) * 1000);
        const abort = () => stream.close();
        signal?.addEventListener("abort", abort, { once: true });
        stream.on("data", onData);
        stream.stderr.on("data", onData);
        stream.on("close", (code: number | null) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut || code === 124 || code === 137) reject(new Error(`timeout:${timeoutSeconds}`));
          else resolve({ exitCode: code });
        });
      }, reject);
    }),
  });

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);
  const targetsLocalServerMemory = (path: unknown): boolean => {
    if (!remote || typeof path !== "string") return false;
    return resolve(path.replace(/^@/, "")) === serverMemoryFilePath(remote);
  };
  pi.registerTool({
    ...localRead,
    description: `Read file contents. Remote text reads fetch only the requested range and return at most ${DEFAULT_READ_MAX_LINES} lines or ${formatSize(DEFAULT_READ_MAX_BYTES)} by default; use offset/limit to continue.`,
    promptGuidelines: ["Use read with offset/limit for remote code and logs; inspect large files in focused chunks instead of reading them wholesale."],
    execute: (id, params, signal, update) => remote && routeRemoteTools && !targetsLocalServerMemory(params.path)
      ? executeRemoteRead(id, params, signal, update)
      : localRead.execute(id, params, signal, update),
  });
  pi.registerTool({ ...localWrite, execute: (id, params, signal, update) => remote && routeRemoteTools && !targetsLocalServerMemory(params.path) ? createWriteTool(localCwd, { operations: remoteWriteOps() }).execute(id, params, signal, update) : localWrite.execute(id, params, signal, update) });
  pi.registerTool({ ...localEdit, execute: (id, params, signal, update) => remote && routeRemoteTools && !targetsLocalServerMemory(params.path) ? createEditTool(localCwd, { operations: remoteEditOps() }).execute(id, params, signal, update) : localEdit.execute(id, params, signal, update) });
  pi.registerTool({
    ...localBash,
    description: `Execute a shell command. Remote model-facing output returns at most the last ${DEFAULT_EXEC_MAX_LINES} lines or ${formatSize(DEFAULT_EXEC_MAX_BYTES)} by default; complete oversized output is saved locally.`,
    promptGuidelines: ["When using bash for remote logs and broad searches, use bounded commands such as tail, sed, or rg with limits instead of cat or unbounded find output."],
    execute: async (id, params, signal, update) => {
      if (!remote || !routeRemoteTools) return localBash.execute(id, params, signal, update);
      const result = await createBashTool(localCwd, { operations: remoteBashOps() }).execute(id, params, signal, update);
      return limitRemoteToolResult(result, "exec");
    },
  });

  pi.registerTool({
    name: "remote",
    label: "Remote",
    description: "Control persistent SSH workspaces, run bounded commands, launch and inspect background jobs, read saved output artifacts, or fan out one command across saved endpoints. Exec supports structured env, group, tmux session, log, model-output limits, and incremental cursors. Oversized output returns a compact summary plus artifactRef. Passwords and key passphrases stay in process memory.",
    promptSnippet: "Control SSH workspaces, bounded exec, background jobs, output artifacts, and multi-endpoint fan-out",
    promptGuidelines: [
      "Use remote when the user asks the agent to enter, reconnect, inspect, or leave a remote SSH environment.",
      "Use remote with action chdir when the user asks to change the remote working directory; do not emulate a persistent directory change with action exec and a one-command cwd.",
      "Use remote exec env/background/session/log/group fields instead of building nested shell quoting for long jobs.",
      "For repeated log polls, pass the previous exec result's cursor as sinceCursor; use action artifact with artifactRef for a bounded range of full oversized output.",
      "Use remote job_status for tracked background jobs and fanout for one compact parallel check across several saved endpoints.",
      "Use remote with action memory to locate and inspect the current server-memory JSON file, then use read/edit/write on that exact local path for entry-level changes.",
      "Delete a server-memory JSON entry only after an explicit user request to delete, remove, or forget it. Read the file first, identify the exact entry id, and remove only that object with edit; ask the user if the target is ambiguous and never infer deletion from an update request.",
      `Always set timeout for remote exec and fanout commands; it defaults to ${DEFAULT_REMOTE_TIMEOUT_SECONDS} seconds when omitted.`,
      "Use remote with action disconnect after remote work when the user asks to return to the local environment.",
    ],
    parameters: Type.Object({
      action: StringEnum(["connect", "reconnect", "status", "disconnect", "forget", "forward", "unforward", "exec", "artifact", "job_status", "fanout", "chdir", "note", "memory"] as const),
      command: Type.Optional(Type.String({ description: "SSH command for connect; optionally selects the endpoint for note or memory" })),
      note: Type.Optional(Type.String({ description: "Endpoint note; omit or empty clears it" })),
      cwd: Type.Optional(Type.String({ description: "Remote cwd for chdir, exec, or fanout" })),
      forwards: Type.Optional(Type.String({ description: "Space-separated LOCAL_PORT:REMOTE_HOST:REMOTE_PORT mappings" })),
      remoteCommand: Type.Optional(Type.String({ description: "Shell command for exec or fanout" })),
      timeout: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_REMOTE_TIMEOUT_SECONDS, description: `Timeout seconds; default ${DEFAULT_REMOTE_TIMEOUT_SECONDS}` })),
      displayLines: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DISPLAY_LINES, description: "Collapsed TUI lines only" })),
      modelLines: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_MAX_LINES, description: "Maximum model-facing output lines for this command" })),
      modelBytes: Type.Optional(Type.Integer({ minimum: MIN_MODEL_OUTPUT_BYTES, maximum: DEFAULT_MAX_BYTES, description: "Maximum model-facing output bytes for this command" })),
      sinceCursor: Type.Optional(Type.String({ description: "Cursor from a prior identical exec; return only new output" })),
      env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Environment variables for exec or fanout" })),
      group: Type.Optional(Type.String({ description: "Run command through sg GROUP" })),
      background: Type.Optional(Type.Boolean({ description: "Launch exec with nohup; implied by session" })),
      session: Type.Optional(Type.String({ description: "tmux session name for background exec" })),
      log: Type.Optional(Type.String({ description: "Remote stdout/stderr log path for background exec" })),
      artifactRef: Type.Optional(Type.String({ description: "Artifact reference returned by oversized exec/fanout" })),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "First artifact line to read" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_MAX_LINES, description: "Artifact lines to read" })),
      jobId: Type.Optional(Type.String({ description: "Tracked background job id" })),
      statusCommand: Type.Optional(Type.String({ description: "Optional command returning a JSON object of job metrics" })),
      includeGpu: Type.Optional(Type.Boolean({ description: "Include compact nvidia-smi metrics in job_status" })),
      endpoints: Type.Optional(Type.Array(Type.String(), { maxItems: 16, description: "Saved endpoint keys, SSH aliases, or ssh commands for fanout; defaults to all saved endpoints" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (params.action === "status") {
        const mappings = [...forwardServers.keys()].sort((a, b) => a - b);
        const text = `${remote ? `Connected: ${endpointDisplayLabel(remote)}:${remote.cwd}; tool routing: ${routeRemoteTools ? "remote" : "local"}` : "SSH remote is disconnected"}${mappings.length ? `; forwarded local ports: ${mappings.join(", ")}` : ""}`;
        return { content: [{ type: "text", text }], details: { connected: Boolean(remote), cwd: remote?.cwd, toolRouting: routeRemoteTools ? "remote" : "local", forwardedPorts: mappings } };
      }
      if (params.action === "disconnect" || params.action === "forget") {
        await disconnect(ctx, params.action === "forget");
        return { content: [{ type: "text", text: params.action === "forget" ? "Disconnected and forgot the cached credentials." : "Disconnected from SSH remote and returned to local tools." }], details: { connected: false } };
      }
      if (params.action === "reconnect") {
        if (!remote && !credentialCache.resume) throw new Error("No SSH remote connection is available to reconnect");
        const state = await reconnectRemote();
        return { content: [{ type: "text", text: `Reconnected: ${endpointDisplayLabel(state)}:${state.cwd}` }], details: { connected: true, cwd: state.cwd } };
      }
      if (params.action === "unforward") {
        await stopForwards();
        persistSessionRemoteState();
        return { content: [{ type: "text", text: "Closed all extension-managed SSH port forwards." }], details: { forwardedPorts: [] } };
      }
      if (params.action === "forward") {
        const state = await ensureConnected(ctx);
        const values = params.forwards?.trim().split(/\s+/).filter(Boolean) ?? configuredForwards(state.command);
        if (!values.length) throw new Error(`No port mappings configured in ${REMOTE_CONFIG_FILE}`);
        const specs = values.map(parseForwardSpec);
        await startForwards(specs);
        routeRemoteTools = false;
        credentialCache.resume = { command: state.command, cwd: state.cwd, routeRemoteTools, forwards: [...forwardSpecs.values()].map(serializeForward) };
        if (currentCtx) status(currentCtx);
        persistSessionRemoteState();
        const ports = specs.map((spec) => spec.localPort);
        return { content: [{ type: "text", text: `Forwarded local ports: ${ports.join(", ")}; tools remain local.` }], details: { toolRouting: "local", forwardedPorts: ports } };
      }
      if (params.action === "chdir") {
        await ensureConnected(ctx);
        if (!params.cwd) throw new Error("cwd is required for chdir");
        const resolved = await changeRemoteCwd(params.cwd, ctx);
        return { content: [{ type: "text", text: `Remote working directory: ${resolved}` }], details: { connected: true, cwd: resolved } };
      }
      if (params.action === "note" || params.action === "memory") {
        const command = params.command || lastCommand || activeSshCommand();
        if (!command) throw new Error("No SSH endpoint configured; connect or select an endpoint first");
        const parsed = parseSshCommand(command);
        const label = parsed.label;
        if (params.action === "note") {
          const note = params.note?.trim() || undefined;
          saveEndpointConfig(command, { note });
          if (remote && cacheId(remote) === cacheId(parsed) && currentCtx) status(currentCtx);
          return {
            content: [{ type: "text", text: note ? `SSH remote note updated (${label}): ${note}` : `SSH remote note cleared (${label})` }],
            details: { endpoint: label, note },
          };
        }
        const path = ensureServerMemoryFile(parsed);
        let memory: ServerMemoryFile | undefined;
        try { memory = loadServerMemory(parsed); }
        catch (error) {
          throw new Error(`Invalid server-memory JSON at ${path}: ${(error as Error).message}`);
        }
        const text = memory?.entries.length
          ? `SSH remote server memory (${serverMemoryId(parsed)}) is stored at ${path}:\n${JSON.stringify(memory.entries, null, 2)}`
          : `No server-memory entries are configured for ${serverMemoryId(parsed)}. Use write to create ${path} with schema {"server":"${serverMemoryId(parsed)}","entries":[]}, then use edit for entry-level changes.`;
        return {
          content: [{ type: "text", text }],
          details: { endpoint: label, server: serverMemoryId(parsed), path, entries: memory?.entries ?? [] },
        };
      }
      if (params.action === "artifact") {
        if (!params.artifactRef) throw new Error("artifactRef is required for artifact");
        const artifact = runtimeCache.artifacts.get(params.artifactRef);
        if (!artifact || !existsSync(artifact)) throw new Error(`Unknown or expired output artifact: ${params.artifactRef}`);
        const offset = params.offset ?? 1;
        const limit = params.limit ?? params.modelLines ?? configuredOutputLimits().execMaxLines;
        const result = await localRead.execute(
          _id,
          { path: artifact, offset, limit },
          _signal,
          _update,
        );
        const limited = limitRemoteToolResult(result, "read", offset, limit, params.modelBytes);
        return {
          ...limited,
          details: { ...(limited.details ?? {}), action: "artifact", artifactRef: params.artifactRef, offset, limit },
        };
      }
      if (params.action === "job_status") {
        const limits = configuredOutputLimits();
        if (limits.turnMaxBytes - turnOutputBytes < MIN_MODEL_OUTPUT_BYTES) {
          return limitRemoteToolResult({ content: [{ type: "text", text: "" }], details: { action: "job_status", skipped: true } }, "exec");
        }
        const state = await ensureConnected(ctx);
        const candidates = [...runtimeCache.jobs.values()].filter((job) => job.endpoint === cacheId(state));
        const job = params.jobId
          ? runtimeCache.jobs.get(params.jobId)
          : candidates.length === 1 ? candidates[0] : undefined;
        if (!job) throw new Error(params.jobId ? `Unknown job: ${params.jobId}` : "jobId is required when zero or multiple jobs are tracked");
        if (job.endpoint !== cacheId(state)) throw new Error(`Job ${job.id} belongs to another endpoint`);
        const aliveCheck = job.session
          ? `tmux has-session -t ${quote(`=${job.session}`)} 2>/dev/null`
          : `kill -0 ${job.pid} 2>/dev/null`;
        const shellStatus = await withReconnect((client) => execRemote(client,
          `if ${aliveCheck}; then echo alive=1; else echo alive=0; fi; ` +
          `if test -e ${quote(job.log)}; then echo log_exists=1; stat -c 'log_bytes=%s' ${quote(job.log)}; wc -l < ${quote(job.log)} | sed 's/^/log_lines=/'; else echo log_exists=0; fi`,
          true,
          params.timeout ?? DEFAULT_REMOTE_TIMEOUT_SECONDS,
        ));
        const current: Record<string, unknown> = { startedAt: job.startedAt, session: job.session, pid: job.pid, log: job.log };
        for (const line of shellStatus.toString("utf8").trim().split(/\r?\n/)) {
          const match = line.match(/^([a-z_]+)=(.*)$/);
          if (!match) continue;
          const [, key, value] = match;
          current[key!] = key === "alive" || key === "log_exists"
            ? value === "1"
            : Number.isFinite(Number(value)) ? Number(value) : value;
        }
        if (params.includeGpu) {
          const gpu = await withReconnect((client) => execRemote(client,
            "nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv,noheader,nounits 2>/dev/null || true",
            true,
            params.timeout ?? DEFAULT_REMOTE_TIMEOUT_SECONDS,
          ));
          current.gpus = gpu.toString("utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => {
            const [index, memoryMiB, utilizationPercent] = line.split(",").map((value) => Number(value.trim()));
            return { index, memoryMiB, utilizationPercent };
          });
        }
        if (params.statusCommand) {
          const metrics = await withReconnect((client) => execRemoteLimited(
            client,
            `cd -- ${quote(job.cwd)} && ${params.statusCommand}`,
            params.timeout ?? DEFAULT_REMOTE_TIMEOUT_SECONDS,
            50,
            16 * 1024,
          ));
          if (metrics.fullOutputPath) deleteOutput(metrics.fullOutputPath);
          if (metrics.exitCode !== 0) throw new Error(`statusCommand exited with code ${metrics.exitCode}: ${metrics.content}`);
          if (metrics.truncation.truncated) throw new Error("statusCommand JSON exceeds 50 lines or 16KB");
          const parsed = JSON.parse(metrics.content);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("statusCommand must return one JSON object");
          current.metrics = parsed;
        }
        const changes = changedStatus(job.lastStatus, current);
        job.lastStatus = current;
        const payload = Object.keys(changes).length ? { jobId: job.id, changes } : { jobId: job.id, unchanged: true };
        return limitRemoteToolResult({
          content: [{ type: "text", text: JSON.stringify(payload) }],
          details: { action: "job_status", ...payload, current },
        }, "exec", 1, params.modelLines, params.modelBytes);
      }
      if (params.action === "fanout") {
        if (!params.remoteCommand) throw new Error("remoteCommand is required for fanout");
        if (params.background || params.session || params.log) throw new Error("fanout supports foreground commands only");
        const config = loadRemoteConfig();
        const selectors = params.endpoints?.length ? params.endpoints : Object.keys(config.endpoints ?? {});
        if (!selectors.length) throw new Error("No saved endpoints are configured for fanout");
        const timeoutSeconds = parseRemoteTimeout(params.timeout ?? DEFAULT_REMOTE_TIMEOUT_SECONDS);
        const limits = configuredOutputLimits();
        if (limits.turnMaxBytes - turnOutputBytes < MIN_MODEL_OUTPUT_BYTES) {
          return limitRemoteToolResult({ content: [{ type: "text", text: "" }], details: { action: "fanout", skipped: true } }, "exec");
        }
        const requestedLines = parseOutputLines(params.modelLines ?? Math.min(DEFAULT_FANOUT_LINES, limits.execMaxLines), "Model lines");
        const requestedBytes = parseOutputBytes(params.modelBytes ?? Math.min(DEFAULT_FANOUT_BYTES, limits.execMaxBytes), "Model bytes");
        const perEndpointLines = Math.max(1, Math.floor(requestedLines / selectors.length));
        const perEndpointBytes = Math.max(MIN_MODEL_OUTPUT_BYTES, Math.floor(requestedBytes / selectors.length));
        const invocation = structuredRemoteCommand(params.remoteCommand, params.env, params.group);
        for (const selector of selectors) {
          try {
            const selected = configuredEndpoint(selector);
            if ((!remote || cacheId(remote) !== cacheId(selected.parsed)) && !trustedFingerprint(selected.parsed)) {
              await trustHostInteractive(selected.parsed, ctx);
            }
          } catch {}
        }
        const results = await Promise.all(selectors.map(async (selector) => {
          let temporary: RemoteState | undefined;
          try {
            const selected = configuredEndpoint(selector);
            const active = remote && cacheId(remote) === cacheId(selected.parsed) ? remote : undefined;
            const state = active ?? await establish(selected.parsed, cachedAuthentication(selected.parsed), selected.cwd);
            if (!active) temporary = state;
            const cwd = executionCwd(state, params.cwd);
            const formatted = await execRemoteLimited(
              state.client,
              `cd -- ${quote(cwd)} && ${invocation}`,
              timeoutSeconds,
              perEndpointLines,
              perEndpointBytes,
            );
            const artifactRef = formatted.fullOutputPath ? registerArtifact(formatted.fullOutputPath) : undefined;
            const output = formatted.truncation.truncated && params.modelLines === undefined && params.modelBytes === undefined
              ? truncateTail(formatted.content, { maxLines: 4, maxBytes: 768 }).content
              : formatted.content;
            return {
              endpoint: selected.parsed.label,
              ok: formatted.exitCode === 0,
              exitCode: formatted.exitCode,
              output,
              ...(artifactRef ? { artifactRef, totalLines: formatted.truncation.totalLines, totalBytes: formatted.truncation.totalBytes } : {}),
            };
          } catch (error) {
            return { endpoint: selector, ok: false, error: (error as Error).message };
          } finally {
            temporary?.client.end();
          }
        }));
        const text = JSON.stringify(results);
        return limitRemoteToolResult({
          content: [{ type: "text", text }],
          details: { action: "fanout", results },
        }, "exec", 1, requestedLines, requestedBytes);
      }
      if (params.action === "exec") {
        const state = await ensureConnected(ctx);
        if (!params.remoteCommand) throw new Error("remoteCommand is required for exec");
        const hasStructuredOptions = params.env !== undefined || params.group !== undefined || params.background || params.session || params.log;
        const cdTarget = params.cwd === undefined && !hasStructuredOptions ? standaloneCdTarget(params.remoteCommand) : undefined;
        if (cdTarget !== undefined) {
          const resolved = await changeRemoteCwd(cdTarget, ctx);
          return { content: [{ type: "text", text: resolved }], details: { connected: true, cwd: resolved } };
        }
        const displayLines = parseDisplayLines(params.displayLines ?? configuredDisplayLines());
        const timeoutSeconds = parseRemoteTimeout(params.timeout ?? DEFAULT_REMOTE_TIMEOUT_SECONDS);
        const limits = configuredOutputLimits();
        const modelLines = parseOutputLines(params.modelLines ?? limits.execMaxLines, "Model lines");
        const modelBytes = parseOutputBytes(params.modelBytes ?? limits.execMaxBytes, "Model bytes");
        const cwd = executionCwd(state, params.cwd);
        const invocation = structuredRemoteCommand(params.remoteCommand, params.env, params.group);
        const session = validateSessionName(params.session);
        if (params.log && !params.background && !session) throw new Error("log requires background=true or session");
        if (params.background || session) {
          const jobId = `job_${randomUUID().slice(0, 8)}`;
          const suppliedLog = params.log || `/tmp/pi-ssh-remote-${jobId}.log`;
          const log = suppliedLog.startsWith("/") ? posix.normalize(suppliedLog) : posix.resolve(cwd, suppliedLog);
          const launch = session
            ? `if tmux has-session -t ${quote(`=${session}`)} 2>/dev/null; then echo ${quote(`tmux session already exists: ${session}`)} >&2; exit 73; fi; tmux new-session -d -s ${quote(session)} ${quote(`${invocation} > ${quote(log)} 2>&1`)}`
            : `nohup bash -lc ${quote(invocation)} > ${quote(log)} 2>&1 < /dev/null & echo pid=$!`;
          const launched = await withReconnect((client) => execRemoteLimited(
            client,
            `cd -- ${quote(cwd)} && ${launch}`,
            timeoutSeconds,
            20,
            DEFAULT_LONG_OUTPUT_SUMMARY_BYTES,
          ));
          if (launched.fullOutputPath) deleteOutput(launched.fullOutputPath);
          if (launched.exitCode !== 0) throw new Error(`Background launch exited with code ${launched.exitCode}: ${launched.content}`);
          const pidMatch = launched.content.match(/(?:^|\n)pid=(\d+)/);
          const pid = pidMatch ? Number(pidMatch[1]) : undefined;
          const job: RemoteJob = {
            id: jobId,
            endpoint: cacheId(state),
            cwd,
            log,
            ...(pid ? { pid } : {}),
            ...(session ? { session } : {}),
            startedAt: new Date().toISOString(),
          };
          runtimeCache.jobs.set(jobId, job);
          trimRuntimeMap(runtimeCache.jobs);
          const text = `job_id=${jobId}${pid ? ` pid=${pid}` : ""}${session ? ` session=${session}` : ""} log=${log}`;
          return { content: [{ type: "text", text }], details: { action: "exec", background: true, ...job, displayLines, output: text } };
        }
        const formatted = await withReconnect((client) => execRemoteLimited(
          client,
          `cd -- ${quote(cwd)} && ${invocation}`,
          timeoutSeconds,
          modelLines,
          modelBytes,
        ));
        const artifactRef = formatted.fullOutputPath ? registerArtifact(formatted.fullOutputPath) : undefined;
        const tracked = updateOutputCursor(state, invocation, cwd, formatted.content, formatted.truncation.truncated, params.sinceCursor);
        let text: string;
        if (formatted.truncation.truncated && params.modelLines === undefined && params.modelBytes === undefined) {
          const tail = truncateTail(tracked.output, {
            maxLines: DEFAULT_LONG_OUTPUT_SUMMARY_LINES,
            maxBytes: DEFAULT_LONG_OUTPUT_SUMMARY_BYTES,
          }).content;
          text = `exit_code=${formatted.exitCode} lines=${formatted.truncation.totalLines} bytes=${formatted.truncation.totalBytes}` +
            `${artifactRef ? ` artifact_ref=${artifactRef}` : ""}` +
            `${tracked.discontinuity ? " cursor_discontinuity=true" : ""}` +
            `${tail ? `\ntail:\n${tail}` : ""}`;
        } else {
          const cursor = tracked.cursor ? ` cursor=${tracked.cursor}` : "";
          const discontinuity = tracked.discontinuity ? " cursor_discontinuity=true" : "";
          text = `${tracked.output || "No new output."}\n[exit_code=${formatted.exitCode}${cursor}${discontinuity}${artifactRef ? ` artifact_ref=${artifactRef}` : ""}]`;
        }
        return limitRemoteToolResult({
          content: [{ type: "text", text }],
          details: {
            action: "exec",
            connected: true,
            cwd,
            displayLines,
            modelLines,
            modelBytes,
            output: text,
            exitCode: formatted.exitCode,
            cursor: tracked.cursor,
            cursorDiscontinuity: tracked.discontinuity,
            artifactRef,
            modelLimited: true,
            truncation: formatted.truncation.truncated ? formatted.truncation : undefined,
            fullOutputPath: formatted.fullOutputPath,
          },
        }, "exec", 1, modelLines, modelBytes);
      }
      const command = params.command || lastCommand || activeSshCommand();
      if (!command) throw new Error(`No SSH endpoint configured. Set ${REMOTE_CONFIG_FILE} or pass command.`);
      const state = await connectInteractive(command, ctx, params.cwd ?? configuredCwd(command));
      if (!state) throw new Error(lastConnectionError || "SSH remote connection was cancelled or failed");
      return { content: [{ type: "text", text: `Connected: ${endpointDisplayLabel(state)}:${state.cwd}` }], details: { connected: true, cwd: state.cwd } };
    },
    renderCall(args, theme) {
      return renderRemoteControlCall(args, theme);
    },
    renderResult(result, { expanded }, theme) {
      return renderRemoteControlResult(result, expanded, theme);
    },
  });

  pi.registerCommand("remote", {
    description: "Connect over SSH and manage endpoints: /remote | ssh USER@HOST [-p PORT] [-i KEY] | memory | config | use USER@HOST:PORT | config note TEXT|--clear | config cwd PATH | config display-lines N | config read-max-lines|read-max-bytes|exec-max-lines|exec-max-bytes|turn-max-bytes N | forward [MAPPINGS] | unforward | exec [--timeout SECONDS] [--lines N] COMMAND | cd PATH | status | reload | off | forget",
    handler: async (args, ctx) => {
      const input = args.trim().replace(/^\/?remote(?:\s+|$)/i, "").trim();
      const action = input.toLowerCase();
      if (action === "config") {
        const config = loadRemoteConfig();
        const rows = Object.entries(config.endpoints ?? {}).map(([key, endpoint]) => {
          const active = key === config.activeEndpoint ? "*" : " ";
          const command = endpoint.sshCommand || commandFromEndpointKey(key);
          let parsedEndpoint: ParsedSsh | undefined;
          let memory = "none";
          if (command) {
            parsedEndpoint = parseSshCommand(command);
            const path = serverMemoryFilePath(parsedEndpoint);
            try {
              const entries = loadServerMemory(parsedEndpoint)?.entries ?? [];
              memory = `${entries.length} JSON entr${entries.length === 1 ? "y" : "ies"} (${path})`;
            } catch (error) {
              memory = `invalid JSON (${path}: ${(error as Error).message})`;
            }
          }
          return `${active} ${parsedEndpoint?.label || key}\n    note: ${endpoint.note || "none"}\n    memory: ${memory}\n    SSH: ${endpoint.sshCommand}\n    cwd: ${endpoint.remoteCwd || FALLBACK_REMOTE_CWD}\n    forward: ${endpoint.forwards?.join(", ") || "none"}`;
        });
        const limits = configuredOutputLimits(config);
        ctx.ui.notify(`SSH remote configuration: ${REMOTE_CONFIG_FILE}\nDisplay lines: ${configuredDisplayLines(config)}\nRead output: ${limits.readMaxLines} lines / ${formatSize(limits.readMaxBytes)}\nExec output: ${limits.execMaxLines} lines / ${formatSize(limits.execMaxBytes)}\nPer-turn output: ${formatSize(limits.turnMaxBytes)}\n${rows.join("\n") || "No saved endpoints"}`, "info");
        return;
      }
      if (/^ssh\s+/i.test(input)) {
        const sshArguments = input.replace(/^ssh\s+/i, "").trim();
        const command = `ssh ${sshArguments}`;
        try { parseSshCommand(command); }
        catch (error) { ctx.ui.notify((error as Error).message, "error"); return; }
        await connectInteractive(command, ctx);
        return;
      }
      if (/^(?:config\s+)?use\s+/i.test(input)) {
        const requested = input.replace(/^(?:config\s+)?use\s+/i, "").trim();
        const config = loadRemoteConfig();
        const keys = Object.keys(config.endpoints ?? {});
        const matches = keys.filter((key) => {
          if (key === requested || key.startsWith(requested)) return true;
          const command = config.endpoints?.[key]?.sshCommand;
          if (!command) return false;
          try {
            const parsed = parseSshCommand(command);
            return parsed.label === requested || parsed.sshTarget === requested;
          } catch {
            return false;
          }
        });
        if (matches.length !== 1) {
          ctx.ui.notify(matches.length ? `Endpoint name is ambiguous: ${matches.join(", ")}` : `Endpoint not found: ${requested}`, "error");
          return;
        }
        const key = matches[0]!;
        const command = config.endpoints?.[key]?.sshCommand;
        if (!command) { ctx.ui.notify(`Endpoint has no SSH command: ${key}`, "error"); return; }
        if (remote && cacheId(remote) !== key) {
          connectionGeneration++;
          const previous = remote;
          remote = null;
          routeRemoteTools = false;
          credentialCache.resume = undefined;
          previous.client.end();
          await stopForwards();
          status(ctx);
          persistSessionRemoteState();
        }
        saveRemoteConfig({ ...config, activeEndpoint: key });
        lastCommand = command;
        ctx.ui.notify(`Selected SSH remote endpoint: ${key}; use /remote to connect`, "info");
        return;
      }
      if (/^config\s+note(?:\s+|$)/i.test(input)) {
        const value = input.replace(/^config\s+note\s*/i, "").trim();
        if (!value) { ctx.ui.notify("Use /remote config note TEXT or /remote config note --clear", "error"); return; }
        const command = lastCommand || activeSshCommand();
        if (!command) { ctx.ui.notify("Configure an SSH endpoint first", "error"); return; }
        const note = value.toLowerCase() === "--clear" ? undefined : value;
        saveEndpointConfig(command, { note });
        if (remote && cacheId(remote) === cacheId(parseSshCommand(command))) status(ctx);
        ctx.ui.notify(note ? `SSH remote note updated (${parseSshCommand(command).label}): ${note}` : `SSH remote note cleared (${parseSshCommand(command).label})`, "info");
        return;
      }
      if (action === "memory") {
        const command = remote?.command || lastCommand || activeSshCommand();
        if (!command) { ctx.ui.notify("Configure an SSH endpoint first", "error"); return; }
        const parsed = parseSshCommand(command);
        let path: string;
        try { path = ensureServerMemoryFile(parsed); }
        catch (error) { ctx.ui.notify(`Could not initialize server-memory JSON: ${(error as Error).message}`, "error"); return; }
        try {
          const memory = loadServerMemory(parsed);
          ctx.ui.notify(`SSH remote server memory (${serverMemoryId(parsed)})\nFile: ${path}\n\n${formatServerMemoryEntries(memory)}`, "info");
        } catch (error) {
          ctx.ui.notify(`Invalid server-memory JSON at ${path}: ${(error as Error).message}`, "error");
        }
        return;
      }
      if (/^config\s+display-lines\s+/i.test(input)) {
        try {
          const displayLines = parseDisplayLines(input.replace(/^config\s+display-lines\s+/i, "").trim());
          saveRemoteConfig({ ...loadRemoteConfig(), displayLines });
          ctx.ui.notify(`SSH remote command preview updated: ${displayLines} lines`, "info");
        } catch (error) { ctx.ui.notify((error as Error).message, "error"); }
        return;
      }
      const outputConfig = input.match(/^config\s+(read-max-lines|read-max-bytes|exec-max-lines|exec-max-bytes|turn-max-bytes)\s+(\S+)$/i);
      if (outputConfig) {
        try {
          const key = outputConfig[1]!.toLowerCase();
          const value = outputConfig[2]!;
          const config = loadRemoteConfig();
          if (key === "read-max-lines") config.readMaxLines = parseOutputLines(value, "Read max lines");
          else if (key === "read-max-bytes") config.readMaxBytes = parseOutputBytes(value, "Read max bytes");
          else if (key === "exec-max-lines") config.execMaxLines = parseOutputLines(value, "Exec max lines");
          else if (key === "exec-max-bytes") config.execMaxBytes = parseOutputBytes(value, "Exec max bytes");
          else config.turnMaxBytes = parseOutputBytes(value, "Turn max bytes", DEFAULT_MAX_BYTES * 4);
          saveRemoteConfig(config);
          ctx.ui.notify(`SSH remote output limit updated: ${key}=${value}`, "info");
        } catch (error) { ctx.ui.notify((error as Error).message, "error"); }
        return;
      }
      if (/^config\s+cwd\s+/i.test(input)) {
        const remoteCwd = input.replace(/^config\s+cwd\s+/i, "").trim();
        const command = lastCommand || activeSshCommand();
        if (!command) { ctx.ui.notify("Configure an SSH endpoint first", "error"); return; }
        saveEndpointConfig(command, { remoteCwd });
        ctx.ui.notify(`Default SSH remote directory updated (${parseSshCommand(command).label}): ${remoteCwd}`, "info");
        return;
      }
      if (/^config\s+forward(?:\s+|$)/i.test(input)) {
        const forwards = input.replace(/^config\s+forward\s*/i, "").trim().split(/\s+/).filter(Boolean);
        try { forwards.forEach(parseForwardSpec); }
        catch (error) { ctx.ui.notify((error as Error).message, "error"); return; }
        const command = lastCommand || activeSshCommand();
        if (!command) { ctx.ui.notify("Configure an SSH endpoint first", "error"); return; }
        saveEndpointConfig(command, { forwards });
        ctx.ui.notify(`SSH remote port-forward configuration updated (${parseSshCommand(command).label}): ${forwards.join(", ") || "none"}`, "info");
        return;
      }
      if (/^forward(?:\s+|$)/i.test(input)) {
        try {
          const state = await ensureConnected(ctx);
          const supplied = input.replace(/^forward\s*/i, "").trim();
          const values = supplied ? supplied.split(/\s+/) : configuredForwards(state.command);
          if (!values.length) throw new Error("No port forwards configured; use /remote config forward LOCAL_PORT:REMOTE_HOST:REMOTE_PORT");
          const specs = values.map(parseForwardSpec);
          await startForwards(specs);
          routeRemoteTools = false;
          credentialCache.resume = { command: state.command, cwd: state.cwd, routeRemoteTools, forwards: [...forwardSpecs.values()].map(serializeForward) };
          status(ctx);
          persistSessionRemoteState();
          ctx.ui.notify(`SSH remote port forwarding started; tools remain local in ${localCwd}: ${specs.map((spec) => `127.0.0.1:${spec.localPort}`).join(", ")}`, "info");
        } catch (error) { ctx.ui.notify(`SSH remote port forwarding failed: ${(error as Error).message}`, "error"); }
        return;
      }
      if (action === "unforward") {
        await stopForwards();
        persistSessionRemoteState();
        ctx.ui.notify("Closed all extension-managed SSH remote port forwards", "info");
        return;
      }
      if (/^exec\s+/i.test(input)) {
        try {
          const state = await ensureConnected(ctx);
          let execInput = input.replace(/^exec\s+/i, "").trim();
          let displayLines = configuredDisplayLines();
          let timeoutSeconds = DEFAULT_REMOTE_TIMEOUT_SECONDS;
          while (execInput.startsWith("--")) {
            const option = execInput.match(/^--(lines|timeout)\s+(\S+)\s+([\s\S]+)$/i);
            if (!option) throw new Error("Expected --lines N or --timeout SECONDS followed by a command");
            if (option[1]!.toLowerCase() === "lines") displayLines = parseDisplayLines(option[2]);
            else timeoutSeconds = parseRemoteTimeout(option[2]);
            execInput = option[3]!;
          }
          const limits = configuredOutputLimits();
          const formatted = await withReconnect((client) => execRemoteLimited(
            client,
            `cd -- ${quote(state.cwd)} && ${execInput}`,
            timeoutSeconds,
            limits.execMaxLines,
            limits.execMaxBytes,
          ));
          const preview = previewRemoteOutput(formatted.content, displayLines);
          const omitted = formatted.truncation.totalLines > displayLines
            ? `\n\n[Showing last ${Math.min(displayLines, formatted.truncation.totalLines)} of ${formatted.truncation.totalLines} lines]`
            : "";
          const fullOutput = formatted.fullOutputPath ? `\n[Full output: ${formatted.fullOutputPath}]` : "";
          const exitCode = formatted.exitCode === 0 ? "" : `\n[Exit code: ${formatted.exitCode}]`;
          ctx.ui.notify(`${preview}${omitted}${fullOutput}${exitCode}`, formatted.exitCode === 0 ? "info" : "error");
        } catch (error) { ctx.ui.notify(`SSH remote command failed: ${(error as Error).message}`, "error"); }
        return;
      }
      if (["off", "disconnect", "exit"].includes(action)) { await disconnect(ctx); return; }
      if (action === "forget") { await disconnect(ctx, true); return; }
      if (action === "status") {
        ctx.ui.notify(remote ? `${endpointDisplayLabel(remote)}:${remote.cwd}` : "SSH remote is disconnected", "info");
        return;
      }
      if (["reload", "reconnect"].includes(action)) {
        try { await reconnectRemote(); }
        catch (error) { ctx.ui.notify(`SSH remote reconnection failed: ${(error as Error).message}`, "error"); }
        return;
      }
      if (/^cd(?:\s+|$)/i.test(input)) {
        if (!remote) { ctx.ui.notify("Connect to SSH remote first", "error"); return; }
        const requested = input.replace(/^cd\s*/i, "").trim() || FALLBACK_REMOTE_CWD;
        try {
          const resolved = await changeRemoteCwd(requested, ctx);
          ctx.ui.notify(`SSH remote path: ${resolved}`, "info");
        } catch (error) { ctx.ui.notify(`Failed to change SSH remote path: ${(error as Error).message}`, "error"); }
        return;
      }
      const command = input || await ctx.ui.input("SSH command:", lastCommand);
      if (!command) return;
      await connectInteractive(command, ctx);
    },
  });

  pi.on("turn_start", () => { turnOutputBytes = 0; });
  pi.on("session_start", async (event, ctx) => {
    currentCtx = ctx;
    sessionReady = true;
    status(ctx);
    const saved = loadSessionRemoteState(ctx);
    const canInheritCurrent = event.reason === "reload" || event.reason === "new" || event.reason === "fork";
    const inherited = !saved && canInheritCurrent && credentialCache.resume ? credentialCache.resume : undefined;
    const target: SessionRemoteState | undefined = saved ?? (inherited ? {
      version: 1,
      connected: true,
      command: inherited.command,
      cwd: inherited.cwd,
      routeRemoteTools: inherited.routeRemoteTools,
      forwards: inherited.forwards ?? [],
    } : undefined);
    if (!target) {
      credentialCache.resume = undefined;
      return;
    }
    restoringSessionState = true;
    try {
      await restoreSessionRemoteState(target, ctx);
    } catch (error) {
      ctx.ui.notify(`SSH remote session restore failed: ${(error as Error).message}`, "error");
    } finally {
      restoringSessionState = false;
    }
    if (inherited && remote) persistSessionRemoteState();
  });
  pi.on("session_shutdown", async (event) => {
    sessionReady = false;
    connectionGeneration++;
    const previous = remote;
    const preserveConnection = event.reason === "reload" || event.reason === "new" || event.reason === "fork";
    if (previous && preserveConnection) {
      credentialCache.resume = {
        command: previous.command,
        cwd: previous.cwd,
        routeRemoteTools,
        forwards: [...forwardSpecs.values()].map(serializeForward),
      };
    }
    remote = null;
    routeRemoteTools = false;
    await stopForwards();
    previous?.client.end();
    if (!preserveConnection) credentialCache.resume = undefined;
  });
  pi.on("user_bash", async (event, ctx) => {
    if (!remote || !routeRemoteTools) return undefined;
    const cdTarget = standaloneCdTarget(event.command);
    if (cdTarget === undefined) return { operations: remoteBashOps() };
    try {
      const resolved = await changeRemoteCwd(cdTarget, ctx);
      return { result: { output: resolved, exitCode: 0, cancelled: false, truncated: false } };
    } catch (error) {
      return { result: { output: (error as Error).message, exitCode: 1, cancelled: false, truncated: false } };
    }
  });
  pi.on("before_agent_start", (event) => remote && routeRemoteTools ? {
    systemPrompt: remoteSystemPrompt(event.systemPrompt, localCwd, remote),
  } : undefined);
  pi.on("context", (event) => {
    if (!remote || !routeRemoteTools) return undefined;
    const content = serverMemoryContext(remote);
    if (!content) return undefined;
    const messages = event.messages.filter((message) =>
      message.role !== "custom" || message.customType !== "ssh-remote-server-memory"
    );
    return {
      messages: [{
        role: "custom",
        customType: "ssh-remote-server-memory",
        content,
        display: false,
        timestamp: Date.now(),
      }, ...messages],
    };
  });
}

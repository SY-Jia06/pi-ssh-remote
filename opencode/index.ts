import type { Hooks, Plugin, PluginOptions, ToolContext, ToolResult } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import {
  OpenSshPool,
  artifactStats,
  parseForwardSpec,
  parseSshCommand,
  quote,
  readArtifact,
  remotePath,
  type ParsedSsh,
  type RunResult,
} from "./core.js";
import { editContent, newFileContent } from "./edit-file.js";
import { planPatch } from "./patch.js";
import { readRemoteFile } from "./read-file.js";
import { RemoteFiles } from "./remote-files.js";

interface EndpointConfig {
  sshCommand?: string;
  remoteCwd?: string;
  forwards?: string[];
  note?: string;
}

interface SessionState {
  command: string;
  cwd: string;
  connectedAt: string;
}

interface RemoteConfig {
  activeEndpoint?: string;
  endpoints?: Record<string, EndpointConfig>;
  sessions?: Record<string, SessionState>;
  readMaxLines?: number;
  readMaxBytes?: number;
  execMaxLines?: number;
  execMaxBytes?: number;
}

interface ServerMemoryEntry {
  id: string;
  content: string;
}

interface ServerMemoryFile {
  server: string;
  entries: ServerMemoryEntry[];
}

interface RemoteJob {
  id: string;
  routeId: string;
  cwd: string;
  log: string;
  pid?: number;
  session?: string;
  startedAt: string;
  lastStatus?: Record<string, unknown>;
}

interface SshRemoteOptions extends PluginOptions {
  configFile?: string;
  importPiConfig?: boolean;
  piConfigFile?: string;
  sshBinary?: string;
}

const DEFAULT_READ_LINES = 400;
const DEFAULT_READ_BYTES = 16 * 1024;
const DEFAULT_EXEC_LINES = 200;
const DEFAULT_EXEC_BYTES = 8 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 2_147_483;
const MAX_RUNTIME_ITEMS = 128;

function expandHome(path: string): string {
  const home = process.env.HOME || ".";
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) && number > 0 && number <= maximum ? number : fallback;
}

function validateConfig(input: unknown, sshBinary: string): RemoteConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const source = input as RemoteConfig;
  const endpoints: Record<string, EndpointConfig> = {};
  let activeEndpoint: string | undefined;

  for (const [oldKey, endpoint] of Object.entries(source.endpoints ?? {})) {
    if (!endpoint || typeof endpoint !== "object") continue;
    const command = typeof endpoint.sshCommand === "string" ? endpoint.sshCommand : undefined;
    let key = oldKey;
    if (command) {
      try { key = parseSshCommand(command, sshBinary).routeId; } catch { continue; }
    }
    endpoints[key] = {
      ...(command ? { sshCommand: command } : {}),
      ...(typeof endpoint.remoteCwd === "string" ? { remoteCwd: endpoint.remoteCwd } : {}),
      ...(Array.isArray(endpoint.forwards) ? { forwards: endpoint.forwards.filter((item): item is string => typeof item === "string") } : {}),
      ...(typeof endpoint.note === "string" && endpoint.note.trim() ? { note: endpoint.note.trim() } : {}),
      ...(endpoints[key] ?? {}),
    };
    if (oldKey === source.activeEndpoint) activeEndpoint = key;
  }

  const sessions = Object.fromEntries(
    Object.entries(source.sessions ?? {}).flatMap(([id, state]) => {
      if (!state || typeof state.command !== "string" || typeof state.cwd !== "string") return [];
      try { parseSshCommand(state.command, sshBinary); } catch { return []; }
      return [[id, {
        command: state.command,
        cwd: state.cwd,
        connectedAt: typeof state.connectedAt === "string" ? state.connectedAt : new Date(0).toISOString(),
      } satisfies SessionState]];
    }).slice(-MAX_RUNTIME_ITEMS),
  );

  activeEndpoint ??= Object.keys(endpoints)[0];
  return {
    ...(activeEndpoint ? { activeEndpoint } : {}),
    ...(Object.keys(endpoints).length ? { endpoints } : {}),
    ...(Object.keys(sessions).length ? { sessions } : {}),
    readMaxLines: boundedInteger(source.readMaxLines, DEFAULT_READ_LINES, 2000),
    readMaxBytes: boundedInteger(source.readMaxBytes, DEFAULT_READ_BYTES, 50 * 1024),
    execMaxLines: boundedInteger(source.execMaxLines, DEFAULT_EXEC_LINES, 2000),
    execMaxBytes: boundedInteger(source.execMaxBytes, DEFAULT_EXEC_BYTES, 50 * 1024),
  };
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}

function changed(previous: Record<string, unknown> | undefined, current: Record<string, unknown>) {
  if (!previous) return current;
  return Object.fromEntries(Object.entries(current).filter(([key, value]) => JSON.stringify(previous[key]) !== JSON.stringify(value)));
}

function shellEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("env must be an object of string values");
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string") {
      throw new Error("env keys must be shell variable names and values must be strings");
    }
    result[key] = item;
  }
  return result;
}

function structuredCommand(command: string, env: unknown, group: unknown): string {
  let result = command;
  const variables = shellEnvironment(env);
  if (Object.keys(variables).length) {
    result = `env ${Object.entries(variables).map(([key, value]) => `${key}=${quote(value)}`).join(" ")} bash -lc ${quote(result)}`;
  }
  if (group !== undefined) {
    if (typeof group !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(group)) throw new Error("group is invalid");
    result = `sg ${quote(group)} -c ${quote(result)}`;
  }
  return result;
}

function sessionName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error("session must contain only letters, digits, dot, underscore, or hyphen");
  return value;
}

function titleFor(parsed: ParsedSsh, path?: string): string {
  return path ? `${parsed.label}:${path}` : parsed.label;
}

export const OpenCodeSshRemote: Plugin = async (input, rawOptions) => {
  const options = (rawOptions ?? {}) as SshRemoteOptions;
  const home = process.env.HOME || ".";
  const sshBinary = typeof options.sshBinary === "string" ? options.sshBinary : "ssh";
  const configFile = expandHome(options.configFile ?? join(home, ".config", "opencode", "ssh-remote-config.json"));
  const piConfigFile = expandHome(options.piConfigFile ?? join(home, ".pi", "agent", "ssh-remote-config.json"));
  const memoryDirectory = join(dirname(configFile), "ssh-remote-memories");
  const piMemoryDirectory = join(dirname(piConfigFile), "ssh-remote-memories");
  const pool = new OpenSshPool(sshBinary);
  const artifacts = new Map<string, string>();
  const jobs = new Map<string, RemoteJob>();

  const loadConfig = (): RemoteConfig => {
    if (!existsSync(configFile) && options.importPiConfig !== false && existsSync(piConfigFile)) {
      try { atomicWriteJson(configFile, validateConfig(readJson(piConfigFile), sshBinary)); } catch {}
    }
    try { return validateConfig(readJson(configFile), sshBinary); } catch { return {}; }
  };
  const saveConfig = (config: RemoteConfig): void => atomicWriteJson(configFile, validateConfig(config, sshBinary));
  const parsed = (command: string): ParsedSsh => parseSshCommand(command, sshBinary);
  const endpointConfig = (config: RemoteConfig, command: string): EndpointConfig => config.endpoints?.[parsed(command).routeId] ?? {};
  const displayLabel = (target: ParsedSsh, config = loadConfig()): string => {
    const note = config.endpoints?.[target.routeId]?.note;
    return note ? `${note} (${target.label})` : target.label;
  };

  const resolveEndpoint = (selector?: string, sessionID?: string): { target: ParsedSsh; config: EndpointConfig } => {
    const all = loadConfig();
    if (selector?.trim().startsWith("ssh ")) {
      const target = parsed(selector.trim());
      return { target, config: all.endpoints?.[target.routeId] ?? {} };
    }
    const session = sessionID ? all.sessions?.[sessionID] : undefined;
    if (!selector && session) {
      const target = parsed(session.command);
      return { target, config: all.endpoints?.[target.routeId] ?? {} };
    }
    const entries = Object.entries(all.endpoints ?? {}).flatMap(([key, config]) => {
      if (!config.sshCommand) return [];
      const target = parsed(config.sshCommand);
      return !selector || selector === key || selector === target.label || selector === target.sshTarget || selector === config.sshCommand
        ? [{ target, config }]
        : [];
    });
    if (!selector && all.activeEndpoint && all.endpoints?.[all.activeEndpoint]?.sshCommand) {
      const config = all.endpoints[all.activeEndpoint]!;
      return { target: parsed(config.sshCommand!), config };
    }
    if (entries.length !== 1) throw new Error(entries.length ? `Endpoint selector is ambiguous: ${selector}` : `Endpoint not found: ${selector ?? "(none configured)"}`);
    return entries[0]!;
  };

  const saveEndpoint = (target: ParsedSsh, updates: EndpointConfig, active = false): void => {
    const config = loadConfig();
    saveConfig({
      ...config,
      ...(active ? { activeEndpoint: target.routeId } : {}),
      endpoints: {
        ...(config.endpoints ?? {}),
        [target.routeId]: { ...(config.endpoints?.[target.routeId] ?? {}), sshCommand: target.command, ...updates },
      },
    });
  };

  const stateFor = (sessionID: string): { state: SessionState; target: ParsedSsh } => {
    const state = loadConfig().sessions?.[sessionID];
    if (!state) throw new Error("No SSH workspace is active in this OpenCode session. Call remote with action=connect first.");
    return { state, target: parsed(state.command) };
  };

  const saveSession = (sessionID: string, target: ParsedSsh, cwd: string): void => {
    const config = loadConfig();
    saveConfig({
      ...config,
      activeEndpoint: target.routeId,
      endpoints: {
        ...(config.endpoints ?? {}),
        [target.routeId]: { ...(config.endpoints?.[target.routeId] ?? {}), sshCommand: target.command, remoteCwd: cwd },
      },
      sessions: {
        ...(config.sessions ?? {}),
        [sessionID]: { command: target.command, cwd, connectedAt: new Date().toISOString() },
      },
    });
  };

  const clearSession = (sessionID: string): SessionState | undefined => {
    const config = loadConfig();
    const state = config.sessions?.[sessionID];
    if (!state) return undefined;
    const sessions = { ...(config.sessions ?? {}) };
    delete sessions[sessionID];
    saveConfig({ ...config, sessions });
    return state;
  };

  const ask = async (ctx: ToolContext, permission: string, target: ParsedSsh, pattern: string, metadata: Record<string, unknown> = {}) => {
    const prefix = `ssh:${target.label}:`;
    await ctx.ask({
      permission,
      patterns: [prefix + pattern],
      always: [prefix + "*"],
      metadata: { endpoint: target.label, ...metadata },
    });
  };

  const mustRun = async (
    target: ParsedSsh,
    command: string,
    timeoutMs = 30_000,
    maxBytes = 16 * 1024,
    maxLines = 2000,
  ): Promise<string> => {
    const result = await pool.run(target, command, { timeoutMs, maxLines, maxBytes });
    if (result.artifactPath) {
      try { unlinkSync(result.artifactPath); } catch {}
    }
    if (result.timedOut) throw new Error(`Remote command timed out after ${Math.ceil(timeoutMs / 1000)} seconds`);
    if (result.exitCode !== 0) throw new Error(result.output.trim() || `Remote command exited with code ${result.exitCode}`);
    if (result.truncated) throw new Error(`Remote command output exceeded ${maxBytes} bytes`);
    return result.output;
  };

  const resolveCwd = async (target: ParsedSsh, requested: string): Promise<string> => {
    const cd = requested === "~" ? "cd -- ~" : `cd -- ${quote(requested)}`;
    return (await mustRun(target, `${cd} && pwd -P`, 15_000, 4096)).trim();
  };

  const rememberArtifact = (path: string): string => {
    const ref = `artifact_${randomUUID().slice(0, 8)}`;
    artifacts.set(ref, path);
    while (artifacts.size > MAX_RUNTIME_ITEMS) {
      const first = artifacts.entries().next().value as [string, string] | undefined;
      if (!first) break;
      artifacts.delete(first[0]);
      try { unlinkSync(first[1]); } catch {}
    }
    return ref;
  };

  const formatRun = (result: RunResult): { output: string; metadata: Record<string, unknown> } => {
    const artifactRef = result.artifactPath ? rememberArtifact(result.artifactPath) : undefined;
    const footer = `[exit_code=${result.exitCode}${artifactRef ? ` artifact_ref=${artifactRef}` : ""}]`;
    const output = result.truncated
      ? `output_truncated lines=${result.totalLines} bytes=${result.totalBytes}${artifactRef ? ` artifact_ref=${artifactRef}` : ""}\ntail:\n${result.output}`
      : `${result.output || "Remote command completed."}\n${footer}`;
    return {
      output,
      metadata: {
        exitCode: result.exitCode,
        totalLines: result.totalLines,
        totalBytes: result.totalBytes,
        truncated: result.truncated,
        ...(artifactRef ? { artifactRef } : {}),
      },
    };
  };

  const memoryPath = (target: ParsedSsh): string => join(memoryDirectory, `${Buffer.from(target.routeId).toString("base64url")}.json`);
  const piMemoryPath = (target: ParsedSsh): string => join(piMemoryDirectory, `${Buffer.from(target.routeId).toString("base64url")}.json`);
  const ensureMemory = (target: ParsedSsh): string => {
    const path = memoryPath(target);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const old = piMemoryPath(target);
      if (options.importPiConfig !== false && existsSync(old)) copyFileSync(old, path);
      else atomicWriteJson(path, { server: target.routeId, entries: [] });
    }
    return path;
  };
  const loadMemory = (target: ParsedSsh): ServerMemoryFile => {
    const data = readJson(ensureMemory(target)) as Partial<ServerMemoryFile>;
    if (data.server !== target.routeId || !Array.isArray(data.entries)) throw new Error("Server-memory JSON has an invalid server or entries field");
    const ids = new Set<string>();
    const entries = data.entries.map((entry, index) => {
      if (!entry || typeof entry.id !== "string" || !entry.id.trim() || typeof entry.content !== "string" || !entry.content.trim()) {
        throw new Error(`Server-memory entry ${index + 1} must have non-empty id and content strings`);
      }
      if (ids.has(entry.id)) throw new Error(`Duplicate server-memory id: ${entry.id}`);
      ids.add(entry.id);
      return { id: entry.id, content: entry.content };
    });
    return { server: target.routeId, entries };
  };

  const active = (ctx: ToolContext) => stateFor(ctx.sessionID);
  const pathFor = (ctx: ToolContext, state: SessionState, requested: string) => remotePath(state.cwd, requested, ctx.directory);

  const executeForeground = async (
    ctx: ToolContext,
    target: ParsedSsh,
    cwd: string,
    command: string,
    timeoutSeconds: number,
    modelLines?: number,
    modelBytes?: number,
  ): Promise<ToolResult> => {
    await ask(ctx, "bash", target, command, { command, cwd });
    const config = loadConfig();
    const result = await pool.run(target, `cd -- ${quote(cwd)} && ${command}`, {
      timeoutMs: timeoutSeconds * 1000,
      maxLines: boundedInteger(modelLines, config.execMaxLines ?? DEFAULT_EXEC_LINES, 2000),
      maxBytes: boundedInteger(modelBytes, config.execMaxBytes ?? DEFAULT_EXEC_BYTES, 50 * 1024),
      signal: ctx.abort,
    });
    const formatted = formatRun(result);
    return { title: titleFor(target, cwd), ...formatted };
  };

  const remoteTool = tool({
    description: "Control persistent SSH workspaces, execute bounded commands, launch and inspect background jobs, manage port forwards, inspect endpoint memory, and fan out across saved endpoints. Uses OpenSSH aliases, ProxyJump, ssh-agent, and ControlMaster. Credentials are never stored by this plugin.",
    args: {
      action: tool.schema.enum(["connect", "reconnect", "status", "disconnect", "forget", "forward", "unforward", "exec", "artifact", "job_status", "fanout", "chdir", "note", "memory"]),
      command: tool.schema.string().optional().describe("SSH command for connect, such as 'ssh node1'; for note/memory it may select an endpoint"),
      endpoint: tool.schema.string().optional().describe("Saved endpoint key, alias, or SSH command for targeted exec/job_status"),
      note: tool.schema.string().optional(),
      cwd: tool.schema.string().optional(),
      forwards: tool.schema.string().optional().describe("Space-separated LOCAL_PORT:REMOTE_HOST:REMOTE_PORT mappings"),
      remoteCommand: tool.schema.string().optional(),
      timeout: tool.schema.number().int().min(1).max(MAX_TIMEOUT_SECONDS).optional(),
      modelLines: tool.schema.number().int().min(1).max(2000).optional(),
      modelBytes: tool.schema.number().int().min(1024).max(50 * 1024).optional(),
      env: tool.schema.record(tool.schema.string(), tool.schema.string()).optional(),
      group: tool.schema.string().optional(),
      background: tool.schema.boolean().optional(),
      session: tool.schema.string().optional(),
      log: tool.schema.string().optional(),
      artifactRef: tool.schema.string().optional(),
      offset: tool.schema.number().int().min(1).optional(),
      limit: tool.schema.number().int().min(1).max(2000).optional(),
      jobId: tool.schema.string().optional(),
      statusCommand: tool.schema.string().optional(),
      includeGpu: tool.schema.boolean().optional(),
      endpoints: tool.schema.array(tool.schema.string()).max(16).optional(),
    },
    async execute(params, ctx) {
      if (params.action === "status") {
        const config = loadConfig();
        const sessionState = config.sessions?.[ctx.sessionID];
        if (!sessionState) {
          const saved = Object.values(config.endpoints ?? {}).map((item) => item.note || item.sshCommand).filter(Boolean);
          return { title: "SSH remote", output: `SSH remote is disconnected in this session.${saved.length ? ` Saved endpoints: ${saved.join(", ")}` : ""}`, metadata: { connected: false } };
        }
        const target = parsed(sessionState.command);
        const transportConnected = await pool.check(target);
        return {
          title: displayLabel(target, config),
          output: `Remote workspace active: ${displayLabel(target, config)}:${sessionState.cwd}; transport: ${transportConnected ? "connected" : "will reconnect on the next operation"}; session: ${ctx.sessionID}`,
          metadata: { connected: true, transportConnected, endpoint: target.label, cwd: sessionState.cwd },
        };
      }

      if (params.action === "artifact") {
        if (!params.artifactRef) throw new Error("artifactRef is required");
        const path = artifacts.get(params.artifactRef);
        if (!path) throw new Error(`Unknown or expired artifact: ${params.artifactRef}`);
        const offset = params.offset ?? 1;
        const limit = params.limit ?? params.modelLines ?? DEFAULT_EXEC_LINES;
        return {
          title: params.artifactRef,
          output: readArtifact(path, offset, limit),
          metadata: { artifactRef: params.artifactRef, offset, limit, ...artifactStats(path) },
        };
      }

      if (params.action === "disconnect" || params.action === "forget") {
        const state = clearSession(ctx.sessionID);
        if (state) await pool.disconnect(parsed(state.command));
        return { title: "SSH remote", output: "Disconnected this OpenCode session from SSH. Local OpenSSH credentials were not modified.", metadata: { connected: false } };
      }

      if (params.action === "unforward") {
        const current = loadConfig().sessions?.[ctx.sessionID];
        const stopped = pool.stopForwards(current ? parsed(current.command) : undefined);
        return { title: "SSH forwards", output: stopped.length ? `Stopped forwarded local ports: ${stopped.join(", ")}` : "No plugin-managed forwards were active.", metadata: { stopped } };
      }

      if (params.action === "connect") {
        const previous = loadConfig().sessions?.[ctx.sessionID];
        const selected = params.command?.startsWith("ssh ")
          ? resolveEndpoint(params.command)
          : resolveEndpoint(params.command, ctx.sessionID);
        await ask(ctx, "remote", selected.target, "connect", { command: selected.target.command });
        await pool.ensure(selected.target, ctx.abort);
        const cwd = await resolveCwd(selected.target, params.cwd ?? selected.config.remoteCwd ?? "~");
        saveEndpoint(selected.target, { ...selected.config, remoteCwd: cwd }, true);
        saveSession(ctx.sessionID, selected.target, cwd);
        if (previous && parsed(previous.command).routeId !== selected.target.routeId) await pool.disconnect(parsed(previous.command));
        return { title: displayLabel(selected.target), output: `Connected: ${displayLabel(selected.target)}:${cwd}. Use remote_read, remote_write, remote_edit, remote_apply_patch, remote_grep, remote_glob, and remote_bash for this workspace.`, metadata: { connected: true, endpoint: selected.target.label, cwd } };
      }

      if (params.action === "reconnect") {
        const { state, target } = active(ctx);
        await ask(ctx, "remote", target, "reconnect");
        await pool.ensure(target, ctx.abort);
        const cwd = await resolveCwd(target, state.cwd);
        saveSession(ctx.sessionID, target, cwd);
        return { title: displayLabel(target), output: `Reconnected: ${displayLabel(target)}:${cwd}`, metadata: { connected: true, cwd } };
      }

      if (params.action === "chdir") {
        if (!params.cwd) throw new Error("cwd is required for chdir");
        const { state, target } = active(ctx);
        const requested = params.cwd.startsWith("/") || params.cwd === "~" ? params.cwd : remotePath(state.cwd, params.cwd);
        const cwd = await resolveCwd(target, requested);
        saveSession(ctx.sessionID, target, cwd);
        return { title: displayLabel(target), output: `Remote working directory: ${cwd}`, metadata: { cwd } };
      }

      if (params.action === "note" || params.action === "memory") {
        const selected = resolveEndpoint(params.command, ctx.sessionID);
        if (params.action === "note") {
          const note = params.note?.trim() || undefined;
          saveEndpoint(selected.target, { ...selected.config, note });
          return { title: selected.target.label, output: note ? `Endpoint note updated: ${note}` : "Endpoint note cleared.", metadata: { note } };
        }
        const path = ensureMemory(selected.target);
        const memory = loadMemory(selected.target);
        return {
          title: `Memory: ${displayLabel(selected.target)}`,
          output: `${memory.entries.length ? JSON.stringify(memory.entries, null, 2) : "No server-memory entries."}\nLocal JSON file: ${path}`,
          metadata: { path, entries: memory.entries, server: memory.server },
        };
      }

      if (params.action === "forward") {
        const { state, target } = active(ctx);
        const configured = endpointConfig(loadConfig(), state.command).forwards ?? [];
        const values = params.forwards?.trim().split(/\s+/).filter(Boolean) ?? configured;
        if (!values.length) throw new Error("No port forwards supplied or configured");
        const specs = values.map(parseForwardSpec);
        await ask(ctx, "remote", target, `forward:${values.join(",")}`, { forwards: values });
        const started: number[] = [];
        try {
          for (const spec of specs) {
            if (await pool.startForward(target, spec)) started.push(spec.localPort);
          }
        } catch (error) {
          pool.stopForwards(target, started);
          throw error;
        }
        const forwardedPorts = specs.map((spec) => spec.localPort);
        saveEndpoint(target, { ...endpointConfig(loadConfig(), state.command), forwards: values });
        return { title: `Forward: ${displayLabel(target)}`, output: `Forwarded local ports: ${forwardedPorts.join(", ")}`, metadata: { forwardedPorts, startedPorts: started } };
      }

      if (params.action === "fanout") {
        if (!params.remoteCommand) throw new Error("remoteCommand is required for fanout");
        if (params.background || params.session || params.log) throw new Error("fanout supports foreground commands only");
        const config = loadConfig();
        const selectors = params.endpoints?.length ? params.endpoints : Object.keys(config.endpoints ?? {});
        if (!selectors.length) throw new Error("No saved endpoints are configured");
        const timeout = params.timeout ?? DEFAULT_TIMEOUT_SECONDS;
        const results = await Promise.all(selectors.map(async (selector) => {
          try {
            const selected = resolveEndpoint(selector);
            await ask(ctx, "bash", selected.target, params.remoteCommand!, { fanout: true });
            const cwd = params.cwd
              ? (params.cwd.startsWith("/") ? params.cwd : remotePath(selected.config.remoteCwd ?? "~", params.cwd))
              : selected.config.remoteCwd ?? "~";
            const command = structuredCommand(params.remoteCommand!, params.env, params.group);
            const result = await pool.run(selected.target, `cd -- ${cwd === "~" ? "~" : quote(cwd)} && ${command}`, {
              timeoutMs: timeout * 1000,
              maxLines: Math.max(1, Math.floor((params.modelLines ?? 48) / selectors.length)),
              maxBytes: Math.max(1024, Math.floor((params.modelBytes ?? 8192) / selectors.length)),
              signal: ctx.abort,
            });
            const artifactRef = result.artifactPath ? rememberArtifact(result.artifactPath) : undefined;
            return { endpoint: selected.target.label, ok: result.exitCode === 0, exitCode: result.exitCode, output: result.output, ...(artifactRef ? { artifactRef } : {}) };
          } catch (error) {
            return { endpoint: selector, ok: false, error: (error as Error).message };
          }
        }));
        return { title: "SSH fanout", output: JSON.stringify(results), metadata: { results } };
      }

      if (params.action === "job_status") {
        const selected = params.endpoint ? resolveEndpoint(params.endpoint) : resolveEndpoint(undefined, ctx.sessionID);
        const candidates = [...jobs.values()].filter((job) => job.routeId === selected.target.routeId);
        const job = params.jobId ? jobs.get(params.jobId) : candidates.length === 1 ? candidates[0] : undefined;
        if (!job || job.routeId !== selected.target.routeId) throw new Error(params.jobId ? `Unknown job: ${params.jobId}` : "jobId is required when zero or multiple jobs are tracked");
        const alive = job.session ? `tmux has-session -t ${quote(`=${job.session}`)} 2>/dev/null` : `kill -0 ${job.pid} 2>/dev/null`;
        const raw = await mustRun(selected.target, `if ${alive}; then echo alive=1; else echo alive=0; fi; if test -e ${quote(job.log)}; then echo log_exists=1; stat -c 'log_bytes=%s' ${quote(job.log)}; wc -l < ${quote(job.log)} | sed 's/^/log_lines=/'; else echo log_exists=0; fi`, (params.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000, 16 * 1024);
        const current: Record<string, unknown> = { startedAt: job.startedAt, session: job.session, pid: job.pid, log: job.log };
        for (const line of raw.trim().split(/\r?\n/)) {
          const match = line.match(/^([a-z_]+)=(.*)$/);
          if (!match) continue;
          const value = match[2]!;
          current[match[1]!] = match[1] === "alive" || match[1] === "log_exists" ? value === "1" : Number.isFinite(Number(value)) ? Number(value) : value;
        }
        if (params.includeGpu) {
          const gpu = await mustRun(selected.target, "nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv,noheader,nounits 2>/dev/null || true", 15_000, 16 * 1024);
          current.gpus = gpu.trim().split(/\r?\n/).filter(Boolean).map((line) => {
            const [index, memoryMiB, utilizationPercent] = line.split(",").map((value) => Number(value.trim()));
            return { index, memoryMiB, utilizationPercent };
          });
        }
        if (params.statusCommand) {
          const metrics = await mustRun(selected.target, `cd -- ${quote(job.cwd)} && ${params.statusCommand}`, (params.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000, 16 * 1024);
          const value = JSON.parse(metrics);
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("statusCommand must return one JSON object");
          current.metrics = value;
        }
        const delta = changed(job.lastStatus, current);
        job.lastStatus = current;
        const payload = Object.keys(delta).length ? { jobId: job.id, changes: delta } : { jobId: job.id, unchanged: true };
        return { title: job.id, output: JSON.stringify(payload), metadata: { ...payload, current } };
      }

      if (params.action === "exec") {
        if (!params.remoteCommand) throw new Error("remoteCommand is required for exec");
        const selected = params.endpoint ? resolveEndpoint(params.endpoint) : resolveEndpoint(undefined, ctx.sessionID);
        const current = loadConfig().sessions?.[ctx.sessionID];
        const base = current && parsed(current.command).routeId === selected.target.routeId ? current.cwd : selected.config.remoteCwd ?? "~";
        const cwd = params.cwd ? (params.cwd.startsWith("/") ? params.cwd : remotePath(base, params.cwd)) : base;
        const invocation = structuredCommand(params.remoteCommand, params.env, params.group);
        const tmux = sessionName(params.session);
        if (params.log && !params.background && !tmux) throw new Error("log requires background=true or session");
        if (params.background || tmux) {
          await ask(ctx, "bash", selected.target, params.remoteCommand, { background: true, cwd });
          const id = `job_${randomUUID().slice(0, 8)}`;
          const suppliedLog = params.log || `/tmp/opencode-ssh-remote-${id}.log`;
          const log = suppliedLog.startsWith("/") ? posix.normalize(suppliedLog) : posix.resolve(cwd, suppliedLog);
          const launch = tmux
            ? `if tmux has-session -t ${quote(`=${tmux}`)} 2>/dev/null; then echo ${quote(`tmux session already exists: ${tmux}`)} >&2; exit 73; fi; tmux new-session -d -s ${quote(tmux)} ${quote(`${invocation} > ${quote(log)} 2>&1`)}`
            : `nohup bash -lc ${quote(invocation)} > ${quote(log)} 2>&1 < /dev/null & pid=$!; disown "$pid"; echo pid=$pid`;
          const output = await mustRun(selected.target, `cd -- ${cwd === "~" ? "~" : quote(cwd)} && mkdir -p -- ${quote(posix.dirname(log))} && { ${launch}; }`, (params.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000, 8192);
          const pid = Number(output.match(/(?:^|\n)pid=(\d+)/)?.[1]) || undefined;
          const job: RemoteJob = { id, routeId: selected.target.routeId, cwd, log, ...(pid ? { pid } : {}), ...(tmux ? { session: tmux } : {}), startedAt: new Date().toISOString() };
          jobs.set(id, job);
          while (jobs.size > MAX_RUNTIME_ITEMS) jobs.delete(jobs.keys().next().value!);
          return { title: id, output: `job_id=${id}${pid ? ` pid=${pid}` : ""}${tmux ? ` session=${tmux}` : ""} log=${log}`, metadata: { ...job, background: true } };
        }
        return executeForeground(ctx, selected.target, cwd, invocation, params.timeout ?? DEFAULT_TIMEOUT_SECONDS, params.modelLines, params.modelBytes);
      }

      throw new Error(`Unsupported remote action: ${params.action}`);
    },
  });

  const remoteRead = tool({
    description: "Read a file or directory in the active SSH workspace. Paths may be remote absolute paths, remote-cwd-relative paths, or local-workspace-shaped absolute paths. Text is line-numbered; image/PDF files are returned as attachments.",
    args: {
      filePath: tool.schema.string(),
      offset: tool.schema.number().int().min(1).optional(),
      limit: tool.schema.number().int().min(1).max(2000).optional(),
    },
    async execute(params, ctx) {
      const { state, target } = active(ctx);
      const path = pathFor(ctx, state, params.filePath);
      await ask(ctx, "read", target, path, { path });
      const config = loadConfig();
      const offset = params.offset ?? 1;
      const limit = Math.min(params.limit ?? config.readMaxLines ?? DEFAULT_READ_LINES, config.readMaxLines ?? DEFAULT_READ_LINES);
      const result = await readRemoteFile(pool, target, path, {
        offset,
        limit,
        maxBytes: config.readMaxBytes ?? DEFAULT_READ_BYTES,
        signal: ctx.abort,
      });
      return {
        title: titleFor(target, path),
        ...result,
        metadata: { ...result.metadata, path, offset },
        ...(result.attachments ? { attachments: result.attachments.map((item) => ({ ...item, filename: posix.basename(path) })) } : {}),
      };
    },
  });

  const remoteWrite = tool({
    description: "Create or overwrite a UTF-8 text file in the active SSH workspace. Parent directories are created automatically. Use remote_apply_patch for code patches. Writes are atomic per file and reject stale snapshots; maximum file size is 10 MiB.",
    args: { filePath: tool.schema.string(), content: tool.schema.string() },
    async execute(params, ctx) {
      const { state, target } = active(ctx);
      const path = pathFor(ctx, state, params.filePath);
      const files = new RemoteFiles(pool, target, ctx.abort);
      const snapshot = await files.snapshot(path);
      await ask(ctx, "edit", target, path, { path, bytes: Buffer.byteLength(params.content) });
      await files.commit([{ ...snapshot, content: params.content }]);
      return { title: titleFor(target, path), output: "Wrote remote file successfully.", metadata: { path, bytes: Buffer.byteLength(params.content) } };
    },
  });

  const remoteEdit = tool({
    description: "Edit a remote UTF-8 text file using OpenCode's native replacement matching and replaceAll semantics. Prefer exact oldString with enough context to be unique. An empty oldString creates a missing file; use remote_write to overwrite an existing file. Maximum file size is 10 MiB.",
    args: {
      filePath: tool.schema.string(),
      oldString: tool.schema.string(),
      newString: tool.schema.string(),
      replaceAll: tool.schema.boolean().optional(),
    },
    async execute(params, ctx) {
      if (params.oldString === params.newString) throw new Error("No changes to apply: oldString and newString are identical.");
      const { state, target } = active(ctx);
      const path = pathFor(ctx, state, params.filePath);
      const files = new RemoteFiles(pool, target, ctx.abort);
      const snapshot = await files.snapshot(path);
      if (!snapshot.exists && params.oldString !== "") throw new Error(`File not found: ${path}`);
      const next = snapshot.exists
        ? editContent(snapshot.content, params.oldString, params.newString, params.replaceAll)
        : newFileContent(params.newString);
      await ask(ctx, "edit", target, path, { path, oldString: params.oldString, newString: params.newString });
      await files.commit([{ ...snapshot, content: next }]);
      return { title: titleFor(target, path), output: "Remote edit applied successfully.", metadata: { path, replaceAll: params.replaceAll ?? false } };
    },
  });

  const remoteApplyPatch = tool({
    description: "Apply an OpenCode-format patch in the active SSH workspace. patchText must contain *** Begin Patch and *** End Patch. Supports *** Add File (+ content), *** Update File (@@ hunks with context and +/- lines, optionally *** Move to), and *** Delete File. Paths use the same mapping as remote_read. All hunks and edit permissions are checked before committing; writes are atomic per file, not a multi-file transaction.",
    args: { patchText: tool.schema.string() },
    async execute(params, ctx) {
      const { state, target } = active(ctx);
      const files = new RemoteFiles(pool, target, ctx.abort);
      const plan = await planPatch(params.patchText, {
        resolvePath: (path) => pathFor(ctx, state, path),
        snapshot: (path) => files.snapshot(path),
      });
      const paths = new Set(plan.files.flatMap((file) => file.movePath ? [file.path, file.movePath] : [file.path]));
      for (const path of paths) await ask(ctx, "edit", target, path, { path, tool: "remote_apply_patch" });
      await files.commit(plan.changes);
      const summary = plan.files.map((file) => {
        if (file.type === "move") return `M ${file.movePath} (moved from ${file.path})`;
        return `${file.type === "add" ? "A" : file.type === "delete" ? "D" : "M"} ${file.path}`;
      }).join("\n");
      return {
        title: `${target.label}: ${plan.files.length} file changes`,
        output: `Success. Updated the following remote files:\n${summary}`,
        metadata: { files: plan.files },
      };
    },
  });

  const remoteGrep = tool({
    description: "Search file contents with ripgrep in the active SSH workspace. Returns matching path, line number, and text.",
    args: {
      pattern: tool.schema.string(),
      path: tool.schema.string().optional(),
      include: tool.schema.string().optional(),
    },
    async execute(params, ctx) {
      const { state, target } = active(ctx);
      const path = pathFor(ctx, state, params.path ?? ".");
      await ask(ctx, "grep", target, `${params.pattern}:${path}`, { pattern: params.pattern, path });
      const config = loadConfig();
      const command = `rg -n --color=never --no-heading --smart-case ${params.include ? `-g ${quote(params.include)} ` : ""}-- ${quote(params.pattern)} ${quote(path)}`;
      const result = await pool.run(target, command, { timeoutMs: 30_000, maxLines: config.execMaxLines, maxBytes: config.execMaxBytes, signal: ctx.abort });
      if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(result.output || `rg exited with code ${result.exitCode}`);
      const formatted = formatRun({ ...result, exitCode: 0 });
      return { title: `${target.label}: grep ${params.pattern}`, output: result.exitCode === 1 ? "No matches found." : formatted.output, metadata: { ...formatted.metadata, pattern: params.pattern, path } };
    },
  });

  const remoteGlob = tool({
    description: "Find files by glob-like path pattern in the active SSH workspace, newest first. Returns at most 200 paths.",
    args: { pattern: tool.schema.string(), path: tool.schema.string().optional() },
    async execute(params, ctx) {
      const { state, target } = active(ctx);
      const absolutePattern = params.pattern.startsWith("/");
      const root = params.path
        ? pathFor(ctx, state, params.path)
        : absolutePattern
          ? (() => {
              const wildcard = params.pattern.search(/[*?\[]/);
              const prefix = wildcard < 0 ? params.pattern : params.pattern.slice(0, wildcard);
              return prefix.endsWith("/") ? prefix.replace(/\/+$/, "") || "/" : posix.dirname(prefix);
            })()
          : state.cwd;
      await ask(ctx, "glob", target, `${params.pattern}:${root}`, { pattern: params.pattern, path: root });
      const absolute = absolutePattern ? params.pattern : `${root.replace(/\/$/, "")}/${params.pattern}`;
      const alternatives = params.pattern.startsWith("**/")
        ? [`-path ${quote(absolute)}`, `-path ${quote(`${root.replace(/\/$/, "")}/${params.pattern.slice(3)}`)}`]
        : [`-path ${quote(absolute)}`];
      const command = `find ${quote(root)} -type f \\( ${alternatives.join(" -o ")} \\) -printf '%T@ %p\\n' 2>/dev/null | sort -nr | cut -d' ' -f2- | head -n 200`;
      const result = await pool.run(target, command, { timeoutMs: 30_000, maxLines: 201, maxBytes: 50 * 1024, signal: ctx.abort });
      if (result.exitCode !== 0) throw new Error(result.output || `find exited with code ${result.exitCode}`);
      const paths = result.output.split(/\r?\n/).filter(Boolean).slice(0, 200);
      if (result.artifactPath) {
        try { unlinkSync(result.artifactPath); } catch {}
      }
      return { title: `${target.label}: ${params.pattern}`, output: paths.length ? paths.join("\n") : "No files found.", metadata: { pattern: params.pattern, path: root, count: paths.length, truncated: paths.length === 200 } };
    },
  });

  const remoteBash = tool({
    description: "Execute a shell command in the active SSH workspace. Uses the persistent remote cwd by default and returns bounded output with artifact references for overflow.",
    args: {
      command: tool.schema.string(),
      timeout: tool.schema.number().int().min(1).max(MAX_TIMEOUT_SECONDS * 1000).optional().describe("Timeout in milliseconds"),
      workdir: tool.schema.string().optional(),
    },
    async execute(params, ctx) {
      const { state, target } = active(ctx);
      const cwd = params.workdir ? pathFor(ctx, state, params.workdir) : state.cwd;
      return executeForeground(ctx, target, cwd, params.command, Math.max(1, Math.ceil((params.timeout ?? DEFAULT_TIMEOUT_SECONDS * 1000) / 1000)));
    },
  });

  const hooks: Hooks = {
    tool: {
      remote: remoteTool,
      remote_read: remoteRead,
      remote_write: remoteWrite,
      remote_edit: remoteEdit,
      remote_apply_patch: remoteApplyPatch,
      remote_grep: remoteGrep,
      remote_glob: remoteGlob,
      remote_bash: remoteBash,
    },
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      if (!sessionID) return;
      const config = loadConfig();
      const state = config.sessions?.[sessionID];
      if (!state) return;
      const target = parsed(state.command);
      let memory = "";
      try {
        const entries = loadMemory(target).entries;
        if (entries.length) memory = `\nServer-specific persistent memory:\n${JSON.stringify(entries, null, 2)}`;
      } catch (error) {
        memory = `\nServer-memory is invalid and must not be applied: ${(error as Error).message}`;
      }
      output.system.push(`SSH REMOTE WORKSPACE ACTIVE\nEndpoint: ${displayLabel(target, config)}\nRemote cwd: ${state.cwd}\nLocal OpenCode directory: ${input.directory}\nUse remote_read, remote_write, remote_edit, remote_apply_patch, remote_grep, remote_glob, and remote_bash for all work intended for this remote workspace. Prefer remote_apply_patch for code patches; use remote_write for whole-file creation or replacement. OpenCode's built-in read/write/edit/grep/glob/bash/apply_patch tools still target the local machine; do not use them for remote files or commands. Use the remote control tool for connection state, persistent chdir, targeted execution, background jobs, artifacts, fanout, forwarding, notes, and memory. Call remote action=disconnect when the user asks to return to local work.${memory}`);
    },
    event: async ({ event }) => {
      if (event.type !== "session.deleted") return;
      const properties = (event as unknown as { properties?: { info?: { id?: string }; id?: string } }).properties;
      const id = properties?.info?.id ?? properties?.id;
      if (id) clearSession(id);
    },
    dispose: async () => pool.dispose(),
  };

  return hooks;
};

export default OpenCodeSshRemote;

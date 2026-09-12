import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ParsedSsh {
  command: string;
  connectionOptions: string[];
  target: string;
  sshTarget: string;
  username: string;
  host: string;
  port: number;
  proxyJump?: string;
  label: string;
  routeId: string;
}

export interface RunOptions {
  timeoutMs?: number;
  maxLines?: number;
  maxBytes?: number;
  input?: string | Buffer;
  signal?: AbortSignal;
  useRemoteTimeout?: boolean;
}

export interface RunResult {
  output: string;
  exitCode: number;
  totalLines: number;
  totalBytes: number;
  truncated: boolean;
  artifactPath?: string;
  timedOut: boolean;
}

export interface ForwardSpec {
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

export function shellWords(input: string): string[] {
  const words: string[] = [];
  let word = "";
  let quoteChar: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of input.trim()) {
    if (escaped) {
      word += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quoteChar !== "'") {
      escaped = true;
      continue;
    }
    if (quoteChar) {
      if (ch === quoteChar) quoteChar = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quoteChar = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (word) {
        words.push(word);
        word = "";
      }
      continue;
    }
    word += ch;
  }
  if (escaped || quoteChar) throw new Error("Incomplete quoting or escaping in SSH command");
  if (word) words.push(word);
  return words;
}

export function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseOpenSshConfig(output: string) {
  const config: { host?: string; user?: string; port?: number; proxyJump?: string } = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(hostname|user|port|proxyjump)\s+(.*)$/);
    if (!match) continue;
    if (match[1] === "hostname") config.host = match[2];
    else if (match[1] === "user") config.user = match[2];
    else if (match[1] === "port") config.port = Number(match[2]);
    else if (match[1] === "proxyjump" && match[2] !== "none") config.proxyJump = match[2];
  }
  return config;
}

export function sshRouteId(route: Pick<ParsedSsh, "username" | "host" | "port" | "sshTarget" | "proxyJump">): string {
  const at = route.sshTarget.lastIndexOf("@");
  const target = at >= 0 ? route.sshTarget.slice(at + 1) : route.sshTarget;
  const jumps = route.proxyJump?.split(",").map((jump) => jump.trim()).filter(Boolean) ?? [];
  const value = JSON.stringify([route.username, route.host, route.port, target, jumps]);
  return `route:${createHash("sha256").update(value).digest("base64url")}`;
}

export function parseSshCommand(command: string, sshBinary = "ssh"): ParsedSsh {
  const words = shellWords(command);
  if (words[0] !== "ssh") throw new Error("Command must start with ssh, for example: ssh user@host -p 22");

  let explicitPort: number | undefined;
  let explicitUser: string | undefined;
  let identityFile: string | undefined;
  let target: string | undefined;
  const connectionOptions: string[] = [];

  for (let index = 1; index < words.length; index++) {
    const arg = words[index]!;
    if (arg === "-p" || arg === "-l" || arg === "-i") {
      const value = words[++index];
      if (!value) throw new Error(`SSH option ${arg} requires a value`);
      if (arg === "-p") explicitPort = Number(value);
      if (arg === "-l") explicitUser = value;
      if (arg === "-i") {
        if (identityFile) throw new Error("Only one SSH identity file may be specified");
        identityFile = value;
      }
      connectionOptions.push(arg, value);
      continue;
    }
    if (/^-p\d+$/.test(arg)) {
      explicitPort = Number(arg.slice(2));
      connectionOptions.push(arg);
      continue;
    }
    if (arg.startsWith("-i") && arg.length > 2) {
      if (identityFile) throw new Error("Only one SSH identity file may be specified");
      identityFile = arg.slice(2);
      connectionOptions.push(arg);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unsupported SSH option ${arg}; use an OpenSSH Host alias for advanced options`);
    }
    if (target) throw new Error("Unexpected extra argument in SSH command");
    target = arg;
  }

  if (!target) throw new Error("SSH host is required");
  if (explicitPort !== undefined && (!Number.isInteger(explicitPort) || explicitPort < 1 || explicitPort > 65535)) {
    throw new Error("Invalid SSH port");
  }
  if (identityFile && identityFile !== "~" && !identityFile.startsWith("~/") && !identityFile.startsWith("/")) {
    throw new Error("SSH identity file must use an absolute path or ~/...");
  }

  const at = target.lastIndexOf("@");
  const requestedHost = at >= 0 ? target.slice(at + 1) : target;
  const requestedUser = at >= 0 ? target.slice(0, at) : explicitUser ?? process.env.USER ?? "root";
  if (!requestedHost || !requestedUser) throw new Error("Invalid SSH username or host");

  let resolved: ReturnType<typeof parseOpenSshConfig> = {};
  try {
    resolved = parseOpenSshConfig(execFileSync(sshBinary, ["-G", ...connectionOptions, target], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }) as string);
  } catch {
    // Literal user@host remains usable if `ssh -G` is unavailable.
  }

  const username = resolved.user || requestedUser;
  const host = resolved.host || requestedHost;
  const port = resolved.port || explicitPort || 22;
  const alias = Boolean(
    resolved.proxyJump || host !== requestedHost || username !== requestedUser || port !== (explicitPort || 22),
  );
  const partial = {
    command,
    connectionOptions,
    target,
    sshTarget: target,
    username,
    host,
    port,
    ...(resolved.proxyJump ? { proxyJump: resolved.proxyJump } : {}),
    label: alias ? target : `${username}@${host}:${port}`,
  };
  return { ...partial, routeId: sshRouteId(partial) };
}

export function parseForwardSpec(value: string): ForwardSpec {
  const match = value.match(/^(\d+):([^:]+):(\d+)$/);
  if (!match) throw new Error(`Invalid forward ${value}; expected LOCAL_PORT:REMOTE_HOST:REMOTE_PORT`);
  const localPort = Number(match[1]);
  const remoteHost = match[2]!;
  const remotePort = Number(match[3]);
  if (![localPort, remotePort].every((port) => Number.isInteger(port) && port > 0 && port <= 65535)) {
    throw new Error(`Port out of range in forward ${value}`);
  }
  return { localPort, remoteHost, remotePort };
}

export function remotePath(cwd: string, requested: string, localDirectory?: string): string {
  const clean = requested.replace(/^@/, "");
  if (localDirectory && clean === localDirectory) return cwd;
  if (localDirectory && clean.startsWith(localDirectory.replace(/\/$/, "") + "/")) {
    return cwd.replace(/\/$/, "") + clean.slice(localDirectory.length);
  }
  if (clean.startsWith("/")) return clean;
  if (!clean || clean === ".") return cwd;
  return joinPosix(cwd, clean);
}

export function joinPosix(base: string, child: string): string {
  const parts = `${base}/${child}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

export function tailText(input: string, maxLines: number, maxBytes: number): string {
  const lines = input.split("\n");
  const out: string[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0 && out.length < maxLines; index--) {
    const line = lines[index]!;
    const size = Buffer.byteLength(line, "utf8") + (out.length ? 1 : 0);
    if (bytes + size > maxBytes) {
      if (!out.length) {
        const buffer = Buffer.from(line, "utf8");
        let start = Math.max(0, buffer.length - maxBytes);
        while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
        out.unshift(buffer.subarray(start).toString("utf8"));
      }
      break;
    }
    out.unshift(line);
    bytes += size;
  }
  return out.join("\n");
}

function countLines(buffer: Buffer): number {
  if (!buffer.length) return 0;
  let lines = 1;
  for (const byte of buffer) if (byte === 10) lines++;
  return buffer.at(-1) === 10 ? lines - 1 : lines;
}

function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

export class OpenSshPool {
  private readonly forwards = new Map<string, { parsed: ParsedSsh; spec: ForwardSpec }>();
  private readonly outputDirectory: string;

  constructor(
    private readonly sshBinary = "ssh",
    outputDirectory = join(tmpdir(), `opencode-ssh-remote-${process.pid}`),
  ) {
    this.outputDirectory = privateDirectory(outputDirectory);
  }

  private socket(parsed: ParsedSsh): string {
    return join(tmpdir(), `ocssh-${createHash("sha256").update(parsed.routeId).digest("hex").slice(0, 20)}.sock`);
  }

  private args(parsed: ParsedSsh, multiplex = true): string[] {
    return [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=12",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "StrictHostKeyChecking=accept-new",
      ...(multiplex ? ["-o", "ControlMaster=auto", "-o", `ControlPath=${this.socket(parsed)}`, "-o", "ControlPersist=600"] : []),
      ...parsed.connectionOptions,
      parsed.target,
    ];
  }

  async check(parsed: ParsedSsh): Promise<boolean> {
    try {
      await execFileAsync(this.sshBinary, [
        "-o", "BatchMode=yes",
        "-o", `ControlPath=${this.socket(parsed)}`,
        ...parsed.connectionOptions,
        "-O", "check",
        parsed.target,
      ], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  async ensure(parsed: ParsedSsh, signal?: AbortSignal): Promise<void> {
    const result = await this.run(parsed, "true", {
      timeoutMs: 15_000,
      maxLines: 20,
      maxBytes: 4096,
      signal,
      useRemoteTimeout: false,
    });
    if (result.exitCode !== 0) {
      throw new Error(`SSH connection failed for ${parsed.label}: ${result.output || `exit ${result.exitCode}`}\nUse an SSH alias/key that works non-interactively (for encrypted keys, add the key to ssh-agent first).`);
    }
  }

  async disconnect(parsed: ParsedSsh): Promise<void> {
    this.stopForwards(parsed);
    try {
      await execFileAsync(this.sshBinary, [
        "-o", "BatchMode=yes",
        "-o", `ControlPath=${this.socket(parsed)}`,
        ...parsed.connectionOptions,
        "-O", "exit",
        parsed.target,
      ], { timeout: 3000 });
    } catch {
      // A missing master already means disconnected.
    }
  }

  async run(parsed: ParsedSsh, command: string, options: RunOptions = {}): Promise<RunResult> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxLines = options.maxLines ?? 200;
    const maxBytes = options.maxBytes ?? 8 * 1024;
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const remoteCommand = options.useRemoteTimeout === false
      ? command
      : `timeout --signal=TERM --kill-after=2s ${seconds}s bash -lc ${quote(command)}`;
    const artifactPath = join(this.outputDirectory, `output-${randomUUID()}.log`);
    const fd = openSync(artifactPath, "wx", 0o600);

    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(this.sshBinary, [...this.args(parsed), remoteCommand], { stdio: ["pipe", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let retainedBytes = 0;
      let totalBytes = 0;
      let totalLines = 0;
      let lastByte: number | undefined;
      let settled = false;
      let timedOut = false;
      const retainLimit = Math.max(maxBytes * 2, 64 * 1024);

      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        closeSync(fd);
        try { unlinkSync(artifactPath); } catch {}
        reject(error);
      };

      const onData = (value: Buffer | string) => {
        const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (!data.length) return;
        writeSync(fd, data);
        totalBytes += data.length;
        for (const byte of data) if (byte === 10) totalLines++;
        lastByte = data.at(-1);
        chunks.push(data);
        retainedBytes += data.length;
        while (retainedBytes > retainLimit && chunks.length > 1) retainedBytes -= chunks.shift()!.length;
        if (chunks.length === 1 && retainedBytes > retainLimit) {
          chunks[0] = chunks[0]!.subarray(chunks[0]!.length - retainLimit);
          retainedBytes = chunks[0]!.length;
        }
      };

      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", finishError);
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        // SSH may reject/close a channel before a file upload finishes. Preserve
        // its stderr and exit status instead of emitting an uncaught pipe error.
        if (["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"].includes(error.code ?? "")) return;
        child.kill("SIGTERM");
        finishError(error);
      });

      const abort = () => child.kill("SIGTERM");
      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1500).unref();
      }, timeoutMs + 8000);

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        closeSync(fd);
        if (lastByte === 10 && totalLines > 0) {
          // Newline count already equals the number of visible lines.
        } else if (totalBytes > 0) totalLines++;

        let output: string;
        const truncated = totalBytes > maxBytes || totalLines > maxLines;
        if (!truncated) {
          output = readFileSync(artifactPath, "utf8");
          try { unlinkSync(artifactPath); } catch {}
        } else {
          output = tailText(Buffer.concat(chunks).toString("utf8"), maxLines, maxBytes);
        }
        resolve({
          output,
          exitCode: code ?? (timedOut ? 124 : 1),
          totalLines,
          totalBytes,
          truncated,
          ...(truncated ? { artifactPath } : {}),
          timedOut,
        });
      });

      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }

  async startForward(parsed: ParsedSsh, spec: ForwardSpec): Promise<boolean> {
    const key = `${parsed.routeId}|${spec.localPort}`;
    if (this.forwards.has(key)) return false;
    await this.ensure(parsed);
    const value = `${spec.localPort}:${spec.remoteHost}:${spec.remotePort}`;
    try {
      await execFileAsync(this.sshBinary, [
        "-o", "BatchMode=yes",
        "-o", `ControlPath=${this.socket(parsed)}`,
        ...parsed.connectionOptions,
        "-O", "forward",
        "-L", value,
        parsed.target,
      ], { timeout: 15_000 });
    } catch (error) {
      const detail = (error as Error & { stderr?: string }).stderr?.trim() || (error as Error).message;
      throw new Error(`SSH port forward failed for ${value}: ${detail}`);
    }
    this.forwards.set(key, { parsed, spec });
    return true;
  }

  stopForwards(parsed?: ParsedSsh, ports?: number[]): number[] {
    const stopped: number[] = [];
    for (const [key, forward] of this.forwards) {
      if (parsed && forward.parsed.routeId !== parsed.routeId) continue;
      if (ports && !ports.includes(forward.spec.localPort)) continue;
      const value = `${forward.spec.localPort}:${forward.spec.remoteHost}:${forward.spec.remotePort}`;
      try {
        execFileSync(this.sshBinary, [
          "-o", "BatchMode=yes",
          "-o", `ControlPath=${this.socket(forward.parsed)}`,
          ...forward.parsed.connectionOptions,
          "-O", "cancel",
          "-L", value,
          forward.parsed.target,
        ], { timeout: 3000, stdio: "ignore" });
      } catch {
        // Closing a missing master or already-closed forward is idempotent.
      }
      this.forwards.delete(key);
      stopped.push(forward.spec.localPort);
    }
    return stopped;
  }

  dispose(): void {
    this.stopForwards();
    try { rmSync(this.outputDirectory, { recursive: true, force: true }); } catch {}
  }
}

export function artifactStats(path: string): { bytes: number; lines: number } {
  const bytes = statSync(path).size;
  const content = readFileSync(path);
  return { bytes, lines: countLines(content) };
}

export function readArtifact(path: string, offset: number, limit: number): string {
  if (!existsSync(path)) throw new Error("Output artifact has expired");
  return readFileSync(path, "utf8").split(/\r?\n/).slice(offset - 1, offset - 1 + limit).join("\n");
}

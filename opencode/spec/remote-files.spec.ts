import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OpenSshPool, type ParsedSsh, type RunOptions, type RunResult } from "../core.js";
import { RemoteFiles } from "../remote-files.js";

const LIMIT = 10 * 1024 * 1024;
const target: ParsedSsh = {
  command: "ssh fixture", connectionOptions: [], target: "fixture", sshTarget: "fixture",
  username: "fixture", host: "fixture", port: 22, label: "fixture", routeId: "fixture",
};
let root: string;
let fixture: string;
let runtimeDirectory: string;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "remote-files-spec-"));
  root = join(fixture, "files");
  runtimeDirectory = join(fixture, "runtime");
  mkdirSync(root);
  mkdirSync(runtimeDirectory);
});
afterEach(() => {
  // All Python children have exited; this private fixture owns its lock artifacts.
  rmSync(fixture, { recursive: true, force: true });
  expect(existsSync(fixture)).toBe(false);
});

function pythonEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, TMPDIR: runtimeDirectory };
}

function localPool(settings: {
  input?: (input: Buffer) => Buffer;
  prefix?: string;
  env?: NodeJS.ProcessEnv;
  started?: (child: ChildProcess) => void;
} = {}) {
  const calls: { command: string; options: RunOptions }[] = [];
  const pool = {
    async run(parsed: ParsedSsh, command: string, options: RunOptions = {}): Promise<RunResult> {
      expect(parsed).toBe(target);
      calls.push({ command, options });
      return new Promise((resolve, reject) => {
        // Execute the actual generated Python program locally; no SSH or endpoint lookup.
        const child = spawn("/bin/sh", ["-c", (settings.prefix ?? "") + "exec " + command], {
          cwd: root, env: pythonEnvironment(settings.env), stdio: ["pipe", "pipe", "pipe"],
        });
        const chunks: Buffer[] = [];
        const abort = () => { child.kill("SIGTERM"); };
        options.signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => child.kill("SIGKILL"), 35_000);
        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.stderr.on("data", (chunk) => chunks.push(chunk));
        child.stdin.on("error", () => {}); // Broken stdin is represented by the process exit.
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
          const output = Buffer.concat(chunks).toString("utf8");
          const totalBytes = Buffer.byteLength(output);
          const totalLines = output.trimEnd().split("\n").length;
          resolve({
            output, exitCode: code ?? 1, totalLines, totalBytes, timedOut: false,
            truncated: totalBytes > (options.maxBytes ?? 8192) || totalLines > (options.maxLines ?? 200),
          });
        });
        const input = Buffer.from(options.input ?? "");
        child.stdin.end(settings.input ? settings.input(input) : input);
        settings.started?.(child);
      });
    },
  } as unknown as OpenSshPool;
  return { pool, calls, files: new RemoteFiles(pool, target) };
}

function names(path = root): string[] {
  return readdirSync(path, { recursive: true }).map(String).sort();
}

describe("RemoteFiles with local Python transport", () => {
  test("keeps one stable lock inside the fixture's dedicated TMPDIR", async () => {
    const { files } = localPool();
    const path = join(root, "file");
    await files.snapshot(path);
    const entries = readdirSync(runtimeDirectory);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^opencode-ssh-remote-files-\d+\.lock$/);
    const lock = join(runtimeDirectory, entries[0]!);
    const before = statSync(lock);
    await files.commit([{ path, version: null, content: "text" }]);
    await localPool().files.snapshot(path);
    const after = statSync(lock);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    expect(readdirSync(runtimeDirectory)).toEqual(entries);
  });

  test("snapshots missing files and round-trips UTF-8, CRLF, and shell metacharacters", async () => {
    const { files, calls } = localPool();
    const path = join(root, "new parent", "'$(touch injected); 中文.txt");
    const missing = await files.snapshot(path);
    expect(missing).toEqual({ path, content: "", version: null, exists: false, identity: expect.any(String) });
    expect(await files.snapshot(path)).toEqual(missing);
    const content = "第一行\r\nemoji: 🐎\nno final newline";
    await files.commit([{ ...missing, content }]);
    const snapshot = await files.snapshot(path);
    expect(snapshot).toEqual({ path, content, version: expect.any(String), exists: true });
    expect(await files.snapshot(path)).toEqual(snapshot);
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(existsSync(join(root, "injected"))).toBe(false);
    expect(calls.every(({ command }) => command.startsWith("python3 -c "))).toBe(true);
    expect(calls.every(({ options }) => options.useRemoteTimeout === false)).toBe(true);
  });

  test("creates, updates, and deletes a batch while preserving file modes", async () => {
    const { files } = localPool();
    const update = join(root, "executable");
    const remove = join(root, "remove");
    const create = join(root, "nested", "created");
    writeFileSync(update, "old");
    chmodSync(update, 0o751);
    writeFileSync(remove, "delete me");
    await files.commit([
      { ...(await files.snapshot(update)), content: "new" },
      { ...(await files.snapshot(remove)), content: null },
      { path: create, version: null, content: "created" },
      { path: join(root, "already absent"), version: null, content: null },
    ]);
    expect(readFileSync(update, "utf8")).toBe("new");
    expect(statSync(update).mode & 0o7777).toBe(0o751);
    expect(existsSync(remove)).toBe(false);
    expect(readFileSync(create, "utf8")).toBe("created");
    expect(statSync(create).mode & 0o777).toBe(0o666 & ~process.umask());
    expect(names().some((name) => name.includes(".opencode-ssh-remote-"))).toBe(false);
  });

  test("refuses stale content, mode changes, same-content replacement, and changed existence", async () => {
    const { files } = localPool();
    const path = join(root, "file");
    writeFileSync(path, "original");
    const original = await files.snapshot(path);
    writeFileSync(path, "external change");
    await expect(files.commit([{ ...original, content: "lost update" }])).rejects.toThrow("Stale file snapshot");
    const modified = await files.snapshot(path);
    chmodSync(path, 0o700);
    await expect(files.commit([{ ...modified, content: null }])).rejects.toThrow("Stale file snapshot");
    const modeChanged = await files.snapshot(path);
    writeFileSync(join(root, "replacement"), "external change", { mode: 0o700 });
    renameSync(join(root, "replacement"), path);
    await expect(files.commit([{ ...modeChanged, content: "lost update" }])).rejects.toThrow("Stale file snapshot");
    const replaced = await files.snapshot(path);
    rmSync(path);
    await expect(files.commit([{ ...replaced, content: "recreate" }])).rejects.toThrow("Stale file snapshot");
    const missing = await files.snapshot(path);
    writeFileSync(path, "new external file");
    await expect(files.commit([{ ...missing, content: "clobber" }])).rejects.toThrow("Stale file snapshot");
    expect(readFileSync(path, "utf8")).toBe("new external file");
  });

  test("validates every precondition before applying any member of a batch", async () => {
    const { files } = localPool();
    const first = join(root, "first");
    const last = join(root, "last");
    writeFileSync(first, "first original");
    writeFileSync(last, "last original");
    const a = await files.snapshot(first);
    const b = await files.snapshot(last);
    writeFileSync(last, "external");
    await expect(files.commit([
      { ...a, content: "must not apply" },
      { path: join(root, "new", "file"), version: null, content: "must not create" },
      { ...b, content: null },
    ])).rejects.toThrow("Stale file snapshot");
    expect(readFileSync(first, "utf8")).toBe("first original");
    expect(readFileSync(last, "utf8")).toBe("external");
    expect(names()).toEqual(["first", "last"]);
  });

  test("follows file and directory symlinks for writes, but unlinks the symlink on delete", async () => {
    const { files } = localPool();
    mkdirSync(join(root, "real"));
    const actual = join(root, "real", "file");
    const link = join(root, "link");
    writeFileSync(actual, "before");
    chmodSync(actual, 0o640);
    symlinkSync("real/file", link);
    symlinkSync("real", join(root, "directory-link"));
    await files.commit([{ ...(await files.snapshot(link)), content: "through file link" }]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(actual, "utf8")).toBe("through file link");
    expect(statSync(actual).mode & 0o777).toBe(0o640);
    const viaDirectory = join(root, "directory-link", "file");
    await files.commit([{ ...(await files.snapshot(viaDirectory)), content: "through directory link" }]);
    expect(readFileSync(actual, "utf8")).toBe("through directory link");
    const newViaDirectory = join(root, "directory-link", "new-file");
    await files.commit([{ ...(await files.snapshot(newViaDirectory)), content: "new through directory link" }]);
    expect(readFileSync(join(root, "real", "new-file"), "utf8")).toBe("new through directory link");
    await files.commit([{ ...(await files.snapshot(link)), content: null }]);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(actual, "utf8")).toBe("through directory link");
  });

  test("supports dangling file symlink writes and detects a retargeted existing symlink", async () => {
    const { files } = localPool();
    const link = join(root, "link");
    symlinkSync("new/target", link);
    const missing = await files.snapshot(link);
    expect(missing.exists).toBe(false);
    expect(missing.identity).toEqual(expect.any(String));
    await files.commit([{ ...missing, content: "created target" }]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, "new", "target"), "utf8")).toBe("created target");
    const snapshot = await files.snapshot(link);
    writeFileSync(join(root, "other"), "created target");
    rmSync(link);
    symlinkSync("other", link);
    await expect(files.commit([{ ...snapshot, content: "clobber" }])).rejects.toThrow("Stale file snapshot");
    expect(readFileSync(join(root, "other"), "utf8")).toBe("created target");
  });

  test.each(["dangling file", "parent directory", "same-target symlink entry"])(
    "rejects stale missing-file identity after changing a %s", async (kind) => {
      const { files } = localPool();
      const link = join(root, "link");
      const parent = kind === "parent directory";
      if (parent) {
        mkdirSync(join(root, "original"));
        mkdirSync(join(root, "retargeted"));
      }
      symlinkSync(parent ? "original" : "original/target", link);
      const path = parent ? join(link, "target") : link;
      const missing = await files.snapshot(path);
      expect(missing.version).toBeNull();
      expect(missing.identity).toEqual(expect.any(String));
      const guard = join(root, "guard");
      writeFileSync(guard, "unchanged");
      const guardSnapshot = await files.snapshot(guard);
      rmSync(link);
      symlinkSync(parent ? "retargeted"
        : kind === "same-target symlink entry" ? "original/target" : "retargeted/target", link);
      expect((await files.snapshot(path)).identity).not.toBe(missing.identity);

      await expect(files.commit([
        { ...guardSnapshot, content: "must not apply" },
        { ...missing, content: "must not create" },
      ])).rejects.toThrow("Stale file snapshot");
      expect(readFileSync(guard, "utf8")).toBe("unchanged");
      expect(existsSync(join(root, "original", "target"))).toBe(false);
      expect(existsSync(join(root, "retargeted", "target"))).toBe(false);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(names().some((name) => name.includes(".opencode-ssh-remote-"))).toBe(false);
    },
  );

  test("revalidates missing-file identity after staging and cleans up on a symlink retarget", async () => {
    const link = join(root, "link");
    symlinkSync("original/target", link);
    const missing = await localPool().files.snapshot(link);
    const hooks = join(fixture, "python-hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "sitecustomize.py"), `import os
fsync = os.fsync
def retarget_after_staging(fd):
    fsync(fd)
    os.unlink(os.environ['RETARGET_LINK'])
    os.symlink('retargeted/target', os.environ['RETARGET_LINK'])
os.fsync = retarget_after_staging
`);
    const { files } = localPool({ env: { PYTHONPATH: hooks, RETARGET_LINK: link } });
    await expect(files.commit([{ ...missing, content: "must not create" }])).rejects.toThrow("Stale file snapshot");
    expect(existsSync(join(root, "original", "target"))).toBe(false);
    expect(existsSync(join(root, "retargeted", "target"))).toBe(false);
    expect(names()).toEqual(["link", "original"]);
  });

  test("rejects duplicate, normalized, symlink, and hardlink aliases", async () => {
    const { files } = localPool();
    const path = join(root, "file");
    writeFileSync(path, "original");
    mkdirSync(join(root, "dir"));
    symlinkSync("file", join(root, "symbolic"));
    linkSync(path, join(root, "hard"));
    const original = await files.snapshot(path);
    for (const alias of [path, `${root}/dir/../file`, join(root, "symbolic"), join(root, "hard")]) {
      await expect(files.commit([
        { ...original, content: "first" },
        { ...(await files.snapshot(alias)), content: "second" },
      ])).rejects.toThrow("Duplicate or aliased file change");
      expect(readFileSync(path, "utf8")).toBe("original");
    }
    await expect(files.commit([
      { path: join(root, "absent"), version: null, content: "one" },
      { path: `${root}/dir/../absent`, version: null, content: "two" },
    ])).rejects.toThrow("Duplicate or aliased file change");
    await expect(files.commit([
      { path: join(root, "parent"), version: null, content: "one" },
      { path: join(root, "parent", "child"), version: null, content: "two" },
    ])).rejects.toThrow("Overlapping file changes");
    expect(existsSync(join(root, "parent"))).toBe(false);
  });

  test("rejects binary, invalid UTF-8, invalid JS text, directories, and oversized files", async () => {
    const { files } = localPool();
    for (const data of [Buffer.from([0x61, 0, 0x62]), Buffer.from([0xff, 0xfe]), Buffer.alloc(LIMIT + 1, 0x61)]) {
      const path = join(root, "invalid");
      writeFileSync(path, data);
      await expect(files.snapshot(path)).rejects.toThrow(/Binary|UTF-8|10 MiB/);
    }
    await expect(files.snapshot(root)).rejects.toThrow();
    for (const content of ["a\0b", "unpaired: \ud800", "a".repeat(LIMIT + 1)]) {
      await expect(files.commit([{ path: join(root, "new"), version: null, content }])).rejects.toThrow(/Binary|UTF-8|10 MiB/);
      expect(existsSync(join(root, "new"))).toBe(false);
    }
  });

  test("does not let a missing path component bypass an existing canonical target's precondition", async () => {
    const { files } = localPool();
    const path = join(root, "existing");
    writeFileSync(path, "keep me");
    const unresolved = `${root}/missing/../existing`;
    await expect(files.snapshot(unresolved)).rejects.toThrow("cannot be resolved safely");
    await expect(files.commit([{ path: unresolved, version: null, content: "clobber" }]))
      .rejects.toThrow("cannot be resolved safely");
    await expect(files.commit([{ path: `${root}/new/`, version: null, content: "file" }]))
      .rejects.toThrow("directory separator");
    expect(readFileSync(path, "utf8")).toBe("keep me");
    expect(names()).toEqual(["existing"]);
  });

  test("accepts the exact 10 MiB boundary without truncating JSON escapes", async () => {
    const { files } = localPool();
    const path = join(root, "limit");
    const content = "\t".repeat(LIMIT);
    await files.commit([{ path, version: null, content }]);
    expect((await files.snapshot(path)).content).toBe(content);
    expect(statSync(path).size).toBe(LIMIT);
  }, 15_000);

  test("rejects incomplete and corrupted stdin without touching originals or creating parents", async () => {
    const path = join(root, "original");
    writeFileSync(path, "keep me");
    const snapshot = await localPool().files.snapshot(path);
    for (const input of [
      (data: Buffer) => data.subarray(0, data.length - 1),
      (data: Buffer) => Buffer.from(data.toString().replace("new text", "bad text")),
    ]) {
      const { files } = localPool({ input });
      await expect(files.commit([
        { ...snapshot, content: "new text" },
        { path: join(root, "new", "file"), version: null, content: "new text" },
      ])).rejects.toThrow("Incomplete or corrupted remote file request");
      expect(readFileSync(path, "utf8")).toBe("keep me");
      expect(names()).toEqual(["original"]);
    }
  });

  test("cleans all staging files after an actual filesystem write failure", async () => {
    const path = join(root, "original");
    writeFileSync(path, "keep me");
    const snapshot = await localPool().files.snapshot(path);
    const { files } = localPool({ prefix: "ulimit -f 1 && " });
    await expect(files.commit([
      { ...snapshot, content: "small staged replacement" },
      { path: join(root, "too-large-for-ulimit"), version: null, content: "x".repeat(16 * 1024) },
    ])).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("keep me");
    expect(names()).toEqual(["original"]);
  });

  test("preserves all move sources if a destination replacement fails after an earlier write", async () => {
    const { files } = localPool();
    const sourceA = join(root, "source-a");
    const sourceB = join(root, "source-b");
    const destinationA = join(root, "destination-a");
    const destinationB = join(root, "destination-b");
    writeFileSync(sourceA, "content A");
    writeFileSync(sourceB, "content B");
    const a = await files.snapshot(sourceA);
    const b = await files.snapshot(sourceB);
    const hooks = join(fixture, "python-hooks");
    mkdirSync(hooks);
    // Python's startup hook injects an OS failure into the actual generated program,
    // after staging and prevalidation, rather than substituting a fake pool result.
    writeFileSync(join(hooks, "sitecustomize.py"), `import os
replace = os.replace
def injected_replace(source, destination, *args, **kwargs):
    if os.path.basename(destination) == 'destination-b':
        raise PermissionError('injected destination replacement failure')
    return replace(source, destination, *args, **kwargs)
os.replace = injected_replace
`);
    const failing = localPool({ env: { PYTHONPATH: hooks } });
    await expect(failing.files.commit([
      { ...a, content: null },
      { path: destinationA, version: null, content: a.content },
      { ...b, content: null },
      { path: destinationB, version: null, content: b.content },
    ])).rejects.toThrow("injected destination replacement failure");
    expect(readFileSync(sourceA, "utf8")).toBe(a.content);
    expect(readFileSync(sourceB, "utf8")).toBe(b.content);
    expect(readFileSync(destinationA, "utf8")).toBe(a.content);
    expect(existsSync(destinationB)).toBe(false);
    expect(names()).toEqual(["destination-a", "source-a", "source-b"]);

    await files.commit([
      { ...b, content: null },
      { path: destinationB, version: null, content: b.content },
    ]);
    expect(existsSync(sourceB)).toBe(false);
    expect(readFileSync(destinationB, "utf8")).toBe(b.content);
  });

  test("serializes independent concurrent invocations so only one stale-base write wins", async () => {
    const path = join(root, "shared");
    writeFileSync(path, "base");
    const snapshot = await localPool().files.snapshot(path);
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
      localPool().files.commit([{ ...snapshot, content: `writer ${i}` }])));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect(String(result.reason)).toContain("Stale file snapshot");
    }
    expect(readFileSync(path, "utf8")).toMatch(/^writer [0-5]$/);
    expect(names()).toEqual(["shared"]);
  });

  test("propagates cancellation before execution and during a blocked invocation", async () => {
    const controller = new AbortController();
    const { pool, calls } = localPool();
    const files = new RemoteFiles(pool, target, controller.signal);
    controller.abort();
    await expect(files.snapshot(join(root, "absent"))).rejects.toThrow();
    await expect(files.commit([])).rejects.toThrow();
    expect(calls).toHaveLength(0);

    // Hold the same POSIX lock in a separate process to make cancellation deterministic.
    const locker = spawn("python3", ["-u", "-c", `import fcntl, os, sys, tempfile
with open(os.path.join(tempfile.gettempdir(), 'opencode-ssh-remote-files-%s.lock' % os.getuid()), 'a') as lock:
    fcntl.lockf(lock, fcntl.LOCK_EX)
    print('locked', flush=True)
    sys.stdin.read()`], { env: pythonEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<void>((resolve) => locker.on("close", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        locker.stdout.once("data", () => resolve());
        locker.once("error", reject);
      });
      const active = new AbortController();
      const blocked = localPool({ started: () => { setTimeout(() => active.abort(), 100); } });
      await expect(new RemoteFiles(blocked.pool, target, active.signal).commit([
        { path: join(root, "absent"), version: null, content: "must not write" },
      ])).rejects.toThrow();
      expect(blocked.calls[0]!.options.signal).toBe(active.signal);
      expect(names()).toEqual([]);
    } finally {
      locker.stdin.end();
      await closed;
    }
  });

  test("preserves the abort reason when cancellation also rejects the transport request", async () => {
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    const pool = {
      run: async () => {
        controller.abort(reason);
        throw new Error("transport closed during cancellation");
      },
    } as unknown as OpenSshPool;
    await expect(new RemoteFiles(pool, target, controller.signal).snapshot(join(root, "absent")))
      .rejects.toBe(reason);
  });

  test.each([false, true])("cleans successful artifacts without adding identity to legacy snapshots (exists=%s)", async (exists) => {
    const path = join(root, "file");
    const snapshot = { path, content: exists ? "text" : "", version: exists ? "version" : null, exists };
    const artifactPath = join(fixture, "transport.log");
    writeFileSync(artifactPath, "internal transport output");
    const pool = {
      run: async () => ({
        output: JSON.stringify(snapshot), exitCode: 0, timedOut: false, truncated: false, artifactPath,
      }),
    } as unknown as OpenSshPool;
    const files = new RemoteFiles(pool, target);
    const actual = await files.snapshot(path);
    expect(actual).toEqual(snapshot);
    expect(Object.hasOwn(actual, "identity")).toBe(false);
    expect(existsSync(artifactPath)).toBe(false);
    // Cleanup is best effort when the pool has already removed its artifact.
    expect(await files.snapshot(path)).toEqual(snapshot);
  });

  test("cleans a returned transport artifact when cancellation is observed after run", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled after run");
    const artifactPath = join(fixture, "transport.log");
    writeFileSync(artifactPath, "internal transport output");
    const pool = {
      run: async () => {
        controller.abort(reason);
        return { output: "{}", exitCode: 0, timedOut: false, truncated: false, artifactPath };
      },
    } as unknown as OpenSshPool;
    await expect(new RemoteFiles(pool, target, controller.signal).snapshot(join(root, "file")))
      .rejects.toBe(reason);
    expect(existsSync(artifactPath)).toBe(false);
  });

  test("propagates Python timeout and transport failures, and refuses truncated responses", async () => {
    // Send SIGALRM to the actual program while stdin is open, without waiting 30 seconds.
    const captured = localPool();
    await captured.files.snapshot(join(root, "absent"));
    const { command } = captured.calls[0]!;
    const child = spawn("/bin/sh", ["-c", `(sleep 0.2; kill -ALRM $$) & exec ${command}`], {
      cwd: root, env: pythonEnvironment(), stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stderr.on("data", (chunk) => { output += chunk; });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(124);
    expect(output).toContain("timed out");

    for (const result of [
      { timedOut: true, exitCode: 0, output: "", truncated: false },
      { timedOut: false, exitCode: 124, output: "", truncated: false },
      { timedOut: false, exitCode: 255, output: "connection lost", truncated: false },
      { timedOut: false, exitCode: 0, output: "{}", truncated: true },
      { timedOut: false, exitCode: 0, output: "{}", truncated: false },
      { timedOut: false, exitCode: 0, output: "not json", truncated: false },
    ]) {
      const artifactPath = join(fixture, "transport.log");
      writeFileSync(artifactPath, "internal transport output");
      const pool = { run: async () => ({ ...result, artifactPath }) } as unknown as OpenSshPool;
      await expect(new RemoteFiles(pool, target).snapshot(join(root, "absent"))).rejects.toThrow();
      expect(existsSync(artifactPath)).toBe(false);
    }
    const failure = new Error("SSH spawn failed");
    const pool = { run: async () => { throw failure; } } as unknown as OpenSshPool;
    await expect(new RemoteFiles(pool, target).snapshot(join(root, "absent"))).rejects.toBe(failure);
  });
});

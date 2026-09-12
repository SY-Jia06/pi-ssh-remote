import { describe, expect, spyOn, test } from "bun:test";
import { tool, type Hooks, type ToolContext, type ToolResult } from "@opencode-ai/plugin";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OpenSshPool, parseSshCommand, type RunResult } from "../core.js";
import OpenCodeSshRemote from "../index.js";

type Permission = Parameters<ToolContext["ask"]>[0] & { sessionID: string };
type Authorize = (request: Permission) => void | Promise<void>;
type StructuredResult = Exclude<ToolResult, string>;

interface Fixture {
  hooks: Hooks;
  remoteA: string;
  remoteB: string;
  localA: string;
  localB: string;
  permissions: Permission[];
  context(sessionID?: string, authorize?: Authorize): ToolContext;
  call(name: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<StructuredResult>;
  requireTool(name: string): void;
}

const ALPHA = "ssh fixture@alpha.invalid";
const BETA = "ssh fixture@beta.invalid";
const SSH_BINARY = "/usr/bin/false";
const alpha = parseSshCommand(ALPHA, SSH_BINARY);
const beta = parseSshCommand(BETA, SSH_BINARY);

function seed(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// Include directories so rejected operations cannot silently leave new parents behind.
function tree(directory: string): Record<string, string> {
  return Object.fromEntries(readdirSync(directory).sort().flatMap((name): [string, string][] => {
    const path = join(directory, name);
    if (!statSync(path).isDirectory()) return [[name, readFileSync(path, "utf8")]];
    return [[`${name}/`, ""], ...Object.entries(tree(path)).map(([child, content]): [string, string] => [`${name}/${child}`, content])];
  }));
}

function editPatterns(fixture: Fixture): string[] {
  return fixture.permissions.filter((request) => request.permission === "edit").flatMap((request) => request.patterns);
}

function permissionFor(path: string, target = alpha): string {
  return `ssh:${target.label}:${path}`;
}

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  // Resolve macOS's /var symlink so `remote connect`'s pwd -P and assertions agree.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "opencode-file-tools-test-")));
  const remoteA = join(root, "remote alpha");
  const remoteB = join(root, "remote beta");
  const localA = join(root, "local alpha");
  const localB = join(root, "local beta");
  for (const path of [remoteA, remoteB, localA, localB]) mkdirSync(path);

  const ensure = spyOn(OpenSshPool.prototype, "ensure").mockImplementation(async (target) => {
    expect([alpha.routeId, beta.routeId]).toContain(target.routeId);
  });
  const run = spyOn(OpenSshPool.prototype, "run").mockImplementation(async (target, command, options = {}): Promise<RunResult> => {
    expect([alpha.routeId, beta.routeId]).toContain(target.routeId);
    options.signal?.throwIfAborted();
    // Execute the adapter/backend's unmodified shell and Python, including stdin.
    // No login shell, actual SSH, user config, or command-shaped fake responses.
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", command], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        TMPDIR: root,
        PYTHONNOUSERSITE: "1",
        LC_ALL: "C",
      },
      input: options.input,
      encoding: "utf8",
      timeout: Math.min(options.timeoutMs ?? 10_000, 10_000),
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    const output = result.stdout + result.stderr;
    const totalBytes = Buffer.byteLength(output);
    const totalLines = output ? output.replace(/\n$/, "").split("\n").length : 0;
    return {
      output,
      exitCode: result.status ?? 1,
      totalBytes,
      totalLines,
      truncated: totalBytes > (options.maxBytes ?? 8192) || totalLines > (options.maxLines ?? 200),
      timedOut: false,
    };
  });

  let hooks: Hooks | undefined;
  try {
    // OpenSshPool's default artifact directory must also belong to this fixture.
    const previousTmpdir = process.env.TMPDIR;
    try {
      process.env.TMPDIR = root;
      hooks = await OpenCodeSshRemote({ directory: localA, worktree: localA } as never, {
        configFile: join(root, "ssh.json"),
        piConfigFile: join(root, "unused-pi-config.json"),
        importPiConfig: false,
        sshBinary: SSH_BINARY,
      });
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }

    const permissions: Permission[] = [];
    const fixture: Fixture = {
      hooks,
      remoteA,
      remoteB,
      localA,
      localB,
      permissions,
      context(sessionID = "session-a", authorize = () => {}) {
        const directory = sessionID === "session-b" ? localB : localA;
        return {
          sessionID,
          messageID: `message-${sessionID}`,
          agent: "build",
          directory,
          worktree: directory,
          abort: new AbortController().signal,
          metadata() {},
          async ask(input) {
            const request = { ...input, sessionID };
            permissions.push(request);
            await authorize(request);
          },
        };
      },
      requireTool(name) {
        if (!hooks?.tool?.[name]) throw new Error(`Missing registered tool: ${name}`);
      },
      async call(name, args, ctx = fixture.context()) {
        fixture.requireTool(name);
        const definition = hooks!.tool![name]!;
        const result = await definition.execute(tool.schema.object(definition.args).parse(args), ctx);
        if (typeof result === "string") throw new Error(`${name} must return structured output and metadata`);
        return result;
      },
    };
    await fixture.call("remote", { action: "connect", command: ALPHA, cwd: remoteA });
    expect(ensure).toHaveBeenCalled();
    permissions.length = 0;
    await body(fixture);
  } finally {
    try {
      await hooks?.dispose?.();
    } finally {
      run.mockRestore();
      ensure.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  }
}

describe("registered remote file tools with local transport", () => {
  test("empty oldString creates only missing files and does not normalize their newlines", () => withFixture(async (f) => {
    const path = join(f.remoteA, "nested", "created.txt");
    await f.call("remote_edit", { filePath: path, oldString: "", newString: "\uFEFFhello\r\nworld" });
    expect(readFileSync(path, "utf8")).toBe("\uFEFFhello\r\nworld");
    await expect(f.call("remote_edit", { filePath: path, oldString: "", newString: "overwrite" })).rejects.toThrow("oldString cannot be empty");
    await expect(f.call("remote_edit", { filePath: "empty.txt", oldString: "", newString: "" })).rejects.toThrow("identical");
    expect(existsSync(join(f.remoteA, "empty.txt"))).toBe(false);
  }));

  test.each(["remote_write", "remote_edit", "remote_apply_patch"])("%s preserves missing-path identity across permission waits", (name) => withFixture(async (f) => {
    const first = join(f.remoteA, "first");
    const second = join(f.remoteA, "second");
    mkdirSync(first);
    mkdirSync(second);
    const link = join(f.remoteA, "link");
    symlinkSync(first, link);
    const path = join(link, "new.txt");
    const ctx = f.context("session-a", (request) => {
      if (request.permission === "edit") {
        unlinkSync(link);
        symlinkSync(second, link);
      }
    });
    const args = name === "remote_write" ? { filePath: path, content: "new\n" }
      : name === "remote_edit" ? { filePath: path, oldString: "", newString: "new\n" }
      : { patchText: "*** Begin Patch\n*** Add File: link/new.txt\n+new\n*** End Patch" };
    await expect(f.call(name, args, ctx)).rejects.toThrow(/stale|changed/i);
    expect(existsSync(join(first, "new.txt"))).toBe(false);
    expect(existsSync(join(second, "new.txt"))).toBe(false);
  }));

  test("write creates and overwrites whole files, then read/edit use the mapped remote file", () => withFixture(async (f) => {
    const name = "nested folder/世界's note.txt";
    const local = join(f.localA, name);
    const remote = join(f.remoteA, name);
    seed(local, "local sentinel\n");
    const initial = "first\nsecond\nthird\n";
    await f.call("remote_write", { filePath: local, content: initial });
    expect(readFileSync(remote, "utf8")).toBe(initial);

    await f.call("remote_write", { filePath: remote, content: "short\n" });
    expect(readFileSync(remote, "utf8")).toBe("short\n");
    await f.call("remote_write", { filePath: name, content: initial });
    const read = await f.call("remote_read", { filePath: local, offset: 2, limit: 1 });
    expect(read.output).toContain("2: second");
    expect(read.output).not.toContain("1: first");
    expect(read.metadata?.path).toBe(remote);

    await f.call("remote_edit", { filePath: local, oldString: "second", newString: "changed" });
    expect(readFileSync(remote, "utf8")).toBe("first\nchanged\nthird\n");
    expect(readFileSync(local, "utf8")).toBe("local sentinel\n");
    expect(new Set(editPatterns(f))).toEqual(new Set([permissionFor(remote)]));
    expect(f.permissions.some((request) => request.permission === "read" && request.patterns.includes(permissionFor(remote)))).toBe(true);
  }));

  test("edit uses official whitespace matching and rejects ambiguous replacements unless replaceAll", () => withFixture(async (f) => {
    const path = join(f.remoteA, "edit.txt");
    seed(path, "function demo() {\n  return 1\n}\nrepeat\nrepeat\n");
    await f.call("remote_edit", {
      filePath: "edit.txt",
      oldString: "function demo() {\n    return 1\n}",
      newString: "function demo() {\n  return 2\n}",
    });
    const before = readFileSync(path, "utf8");
    expect(before).toBe("function demo() {\n  return 2\n}\nrepeat\nrepeat\n");
    await expect(f.call("remote_edit", { filePath: path, oldString: "repeat", newString: "once" })).rejects.toThrow(/multiple|ambiguous/i);
    expect(readFileSync(path, "utf8")).toBe(before);
    await f.call("remote_edit", { filePath: path, oldString: "repeat", newString: "once", replaceAll: true });
    expect(readFileSync(path, "utf8")).toBe("function demo() {\n  return 2\n}\nonce\nonce\n");
  }));

  test("apply_patch handles Add/Update/Delete/Move together and authorizes both move paths", () => withFixture(async (f) => {
    f.requireTool("remote_apply_patch");
    expect(Object.keys(f.hooks.tool!.remote_apply_patch!.args)).toEqual(["patchText"]);
    const added = join(f.remoteA, "new folder/世界's.txt");
    const updated = join(f.remoteA, "update.txt");
    const deleted = join(f.remoteA, "delete.txt");
    const source = join(f.remoteA, "source.sh");
    const destination = join(f.remoteA, "moved folder/destination.sh");
    seed(updated, "alpha\nbeta\n");
    seed(deleted, "remove me\n");
    seed(source, "#!/bin/sh\necho before\n");
    chmodSync(updated, 0o640);
    const before = tree(f.remoteA);
    const result = await f.call("remote_apply_patch", {
      patchText: [
        "*** Begin Patch",
        `*** Add File: ${join(f.localA, "new folder/世界's.txt")}`,
        "+literal $(touch should-not-exist) and 'quotes'",
        `*** Update File: ${updated}`,
        "@@",
        " alpha",
        "-beta",
        "+BETA",
        "*** Delete File: delete.txt",
        `*** Update File: ${join(f.localA, "source.sh")}`,
        `*** Move to: ${destination}`,
        "@@",
        " #!/bin/sh",
        "-echo before",
        "+echo after",
        "*** End Patch",
      ].join("\n"),
    }, f.context("session-a", (request) => {
      if (request.permission === "edit") expect(tree(f.remoteA)).toEqual(before);
    }));

    expect(readFileSync(added, "utf8")).toBe("literal $(touch should-not-exist) and 'quotes'\n");
    expect(readFileSync(updated, "utf8")).toBe("alpha\nBETA\n");
    expect(existsSync(deleted)).toBe(false);
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(destination, "utf8")).toBe("#!/bin/sh\necho after\n");
    expect(statSync(updated).mode & 0o777).toBe(0o640);
    expect(existsSync(join(dirname(f.remoteA), "should-not-exist"))).toBe(false);
    expect(tree(f.localA)).toEqual({});
    expect(new Set(editPatterns(f))).toEqual(new Set([added, updated, deleted, source, destination].map((path) => permissionFor(path))));

    for (const name of ["世界's.txt", "update.txt", "delete.txt", "destination.sh"]) expect(result.output).toContain(name);
    expect(Array.isArray(result.metadata?.files)).toBe(true);
    expect(result.metadata!.files).toHaveLength(4);
    for (const path of [added, updated, deleted, source, destination]) expect(JSON.stringify(result.metadata)).toContain(path);
  }));

  test("denial of a second patch path leaves the earlier add and all existing files unchanged", () => withFixture(async (f) => {
    f.requireTool("remote_apply_patch");
    const denied = join(f.remoteA, "second.txt");
    seed(denied, "before\n");
    seed(join(f.remoteA, "last.txt"), "keep\n");
    const before = tree(f.remoteA);
    const ctx = f.context("session-a", (request) => {
      if (request.permission === "edit" && request.patterns.includes(permissionFor(denied))) throw new Error("fixture edit denied");
    });
    await expect(f.call("remote_apply_patch", {
      patchText: "*** Begin Patch\n*** Add File: new/first.txt\n+new\n*** Update File: second.txt\n@@\n-before\n+after\n*** Delete File: last.txt\n*** End Patch",
    }, ctx)).rejects.toThrow("fixture edit denied");
    expect(editPatterns(f)).toContain(permissionFor(denied));
    expect(tree(f.remoteA)).toEqual(before);
  }));

  test.each(["source.txt", "destination.txt"])("denying move path %s preserves the source and destination", (deniedName) => withFixture(async (f) => {
    f.requireTool("remote_apply_patch");
    seed(join(f.remoteA, "source.txt"), "before\n");
    const before = tree(f.remoteA);
    const denied = permissionFor(join(f.remoteA, deniedName));
    const ctx = f.context("session-a", (request) => {
      if (request.permission === "edit" && request.patterns.includes(denied)) throw new Error("fixture move denied");
    });
    await expect(f.call("remote_apply_patch", {
      patchText: "*** Begin Patch\n*** Add File: earlier.txt\n+earlier\n*** Update File: source.txt\n*** Move to: destination.txt\n@@\n-before\n+after\n*** End Patch",
    }, ctx)).rejects.toThrow("fixture move denied");
    expect(editPatterns(f)).toContain(denied);
    expect(tree(f.remoteA)).toEqual(before);
  }));

  test.each([
    ["failing later hunk", "*** Update File: second.txt\n@@\n-not present\n+after"],
    ["malformed later operation", "*** Not An Operation: second.txt\n+after"],
  ])("a %s prevents all patch mutations", (_name, invalid) => withFixture(async (f) => {
    // A missing registration must fail this test, rather than satisfy rejects.toThrow.
    f.requireTool("remote_apply_patch");
    seed(join(f.remoteA, "first.txt"), "first\n");
    seed(join(f.remoteA, "second.txt"), "second\n");
    const before = tree(f.remoteA);
    await expect(f.call("remote_apply_patch", {
      patchText: `*** Begin Patch\n*** Add File: new/added.txt\n+added\n*** Update File: first.txt\n@@\n-first\n+FIRST\n${invalid}\n*** End Patch`,
    })).rejects.toThrow();
    expect(tree(f.remoteA)).toEqual(before);
  }));

  test.each([
    ["remote_write", "existing.txt"],
    ["remote_write", "new/created.txt"],
    ["remote_edit", "existing.txt"],
  ])("edit denial prevents %s from mutating %s", (name, filePath) => withFixture(async (f) => {
    seed(join(f.remoteA, "existing.txt"), "before\n");
    const before = tree(f.remoteA);
    const args = name === "remote_write"
      ? { filePath, content: "after\n" }
      : { filePath, oldString: "before", newString: "after" };
    const ctx = f.context("session-a", (request) => {
      if (request.permission === "edit") throw new Error("fixture edit denied");
    });
    await expect(f.call(name, args, ctx)).rejects.toThrow("fixture edit denied");
    expect(editPatterns(f)).toContain(permissionFor(join(f.remoteA, filePath)));
    expect(tree(f.remoteA)).toEqual(before);
  }));

  test.each(["remote_write", "remote_edit", "remote_apply_patch"])("%s rejects a snapshot made stale while permission is pending", (name) => withFixture(async (f) => {
    f.requireTool(name);
    const path = join(f.remoteA, "existing.txt");
    seed(path, "before\n");
    const args = name === "remote_write"
      ? { filePath: path, content: "after\n" }
      : name === "remote_edit"
        ? { filePath: path, oldString: "before", newString: "after" }
        : { patchText: "*** Begin Patch\n*** Add File: new/earlier.txt\n+earlier\n*** Update File: existing.txt\n@@\n-before\n+after\n*** End Patch" };
    let changed = false;
    const ctx = f.context("session-a", (request) => {
      if (request.permission === "edit" && request.patterns.includes(permissionFor(path))) {
        changed = true;
        writeFileSync(path, "external change\n");
      }
    });
    await expect(f.call(name, args, ctx)).rejects.toThrow(/stale|changed|modified|conflict/i);
    expect(changed).toBe(true);
    expect(tree(f.remoteA)).toEqual({ "existing.txt": "external change\n" });
  }));

  test.each([ALPHA, BETA])("sessions keep separate cwd/path mappings when the second connects to %s", (secondCommand) => withFixture(async (f) => {
    f.requireTool("remote_apply_patch");
    const ctxB = f.context("session-b");
    await f.call("remote", { action: "connect", command: secondCommand, cwd: f.remoteB }, ctxB);
    await f.call("remote_write", { filePath: join(f.localA, "same.txt"), content: "alpha\n" });
    await f.call("remote_write", { filePath: join(f.localB, "same.txt"), content: "beta\n" }, ctxB);
    await f.call("remote_apply_patch", {
      patchText: `*** Begin Patch\n*** Update File: ${join(f.localB, "same.txt")}\n@@\n-beta\n+BETA\n*** End Patch`,
    }, ctxB);
    await f.call("remote_edit", { filePath: "same.txt", oldString: "alpha", newString: "ALPHA" });
    const readA = await f.call("remote_read", { filePath: "same.txt" });
    const readB = await f.call("remote_read", { filePath: join(f.remoteB, "same.txt") }, ctxB);
    expect(readA.output).toContain("1: ALPHA");
    expect(readB.output).toContain("1: BETA");
    expect(tree(f.remoteA)).toEqual({ "same.txt": "ALPHA\n" });
    expect(tree(f.remoteB)).toEqual({ "same.txt": "BETA\n" });
    expect(tree(f.localA)).toEqual({});
    expect(tree(f.localB)).toEqual({});
    const secondTarget = secondCommand === ALPHA ? alpha : beta;
    expect(new Set(f.permissions.filter((request) => request.sessionID === "session-b" && request.permission === "edit").flatMap((request) => request.patterns)))
      .toEqual(new Set([permissionFor(join(f.remoteB, "same.txt"), secondTarget)]));

    await expect(f.call("remote_write", { filePath: "unconnected.txt", content: "no\n" }, f.context("session-c")))
      .rejects.toThrow(/connect|active.*workspace/i);
    expect(existsSync(join(f.remoteA, "unconnected.txt"))).toBe(false);
    expect(existsSync(join(f.remoteB, "unconnected.txt"))).toBe(false);
  }));
});

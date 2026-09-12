import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpenSshPool,
  joinPosix,
  parseForwardSpec,
  parseSshCommand,
  remotePath,
  shellWords,
  tailText,
} from "../core.js";

describe("shell parsing", () => {
  test("preserves quoted SSH arguments", () => {
    expect(shellWords("ssh -i '~/key file' alice@example.com -p 2202")).toEqual([
      "ssh",
      "-i",
      "~/key file",
      "alice@example.com",
      "-p",
      "2202",
    ]);
  });

  test("normalizes accepted SSH options and target", () => {
    const parsed = parseSshCommand("ssh alice@example.com -p 2202", "/usr/bin/false");
    expect(parsed.target).toBe("alice@example.com");
    expect(parsed.connectionOptions).toEqual(["-p", "2202"]);
    expect(parsed.username).toBe("alice");
    expect(parsed.host).toBe("example.com");
    expect(parsed.port).toBe(2202);
    expect(parsed.routeId).toStartWith("route:");
  });

  test("rejects options that should live in an SSH alias", () => {
    expect(() => parseSshCommand("ssh -o ProxyJump=jump host", "/usr/bin/false")).toThrow("Unsupported SSH option");
  });
});

describe("remote paths", () => {
  test("maps local-workspace-shaped paths to the remote cwd", () => {
    expect(remotePath("/srv/project", "/Users/j/project/src/a.ts", "/Users/j/project")).toBe("/srv/project/src/a.ts");
    expect(remotePath("/srv/project", "../shared/a.ts")).toBe("/srv/shared/a.ts");
    expect(joinPosix("/srv/project", "a/../b")).toBe("/srv/project/b");
  });

});

test("a rejected SSH upload returns diagnostics instead of an unhandled stdin error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-ssh-upload-test-"));
  const ssh = join(directory, "ssh");
  writeFileSync(ssh, "#!/bin/sh\nprintf 'remote upload refused\\n' >&2\nexit 73\n", { mode: 0o700 });
  const pool = new OpenSshPool(ssh, join(directory, "output"));
  try {
    const target = parseSshCommand("ssh fixture@invalid", "/usr/bin/false");
    const result = await pool.run(target, "unused", {
      input: "x".repeat(8 * 1024 * 1024), useRemoteTimeout: false, timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(73);
    expect(result.output).toContain("remote upload refused");
  } finally {
    pool.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("bounded output helpers", () => {
  test("keeps a UTF-8-safe tail", () => {
    expect(tailText("first\nsecond\n第三行", 2, 100)).toBe("second\n第三行");
    expect(() => Buffer.from(tailText("一二三四五", 1, 5), "utf8").toString("utf8")).not.toThrow();
  });

  test("validates forwards", () => {
    expect(parseForwardSpec("7860:127.0.0.1:8000")).toEqual({ localPort: 7860, remoteHost: "127.0.0.1", remotePort: 8000 });
    expect(() => parseForwardSpec("70000:localhost:1")).toThrow("Port out of range");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenCodeSshRemote from "../index.js";

function context(sessionID = "session-test") {
  return {
    sessionID,
    messageID: "message-test",
    agent: "build",
    directory: "/local/project",
    worktree: "/local/project",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  };
}

describe("OpenCode plugin", () => {
  test("registers native tools and reports disconnected status without touching Pi config", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-ssh-plugin-test-"));
    try {
      const hooks = await OpenCodeSshRemote({ directory, worktree: directory } as never, {
        configFile: join(directory, "ssh.json"),
        importPiConfig: false,
        sshBinary: "/usr/bin/false",
      });
      expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
        "remote",
        "remote_apply_patch",
        "remote_bash",
        "remote_edit",
        "remote_glob",
        "remote_grep",
        "remote_read",
        "remote_write",
      ]);
      const result = await hooks.tool!.remote!.execute({ action: "status" }, context());
      expect(typeof result).toBe("object");
      expect((result as { output: string }).output).toContain("disconnected");
      await hooks.dispose?.();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

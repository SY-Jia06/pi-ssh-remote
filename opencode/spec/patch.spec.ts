import { describe, expect, test } from "bun:test";
import { posix } from "node:path";
import { remotePath } from "../core.js";
import { planPatch } from "../patch.js";
import type { FileSnapshot } from "../remote-files.js";
import * as Patch from "../vendor/opencode-patch.js";

const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
const update = (...lines: string[]) => patch("*** Update File: a", ...lines);

function memory(initial: Record<string, string> = {}, resolvePath = (path: string) => posix.resolve("/remote", path)) {
  const stored = new Map<string, FileSnapshot>(Object.entries(initial).map(([path, content]) => {
    const resolved = resolvePath(path);
    return [resolved, Object.freeze({ path: resolved, content, version: `initial:${resolved}`, exists: true })];
  }));
  const reads: string[] = [];
  return {
    stored,
    reads,
    options: {
      resolvePath,
      snapshot: async (path: string): Promise<FileSnapshot> => {
        reads.push(path);
        return stored.get(path) ?? Object.freeze({ path, content: "", version: null, exists: false });
      },
    },
  };
}

async function contents(original: string, ...lines: string[]) {
  const fs = memory({ a: original });
  return (await planPatch(update(...lines), fs.options)).changes[0]!.content;
}

// Upstream core and legacy regression cases, adapted to the pure planner.
// Exact sources and MIT attribution are in vendor/opencode-patch.LICENSE.
describe("official OpenCode 1.18.30 core parser", () => {
  test("parses add, update with context, delete, and move", () => {
    expect(Patch.parse(patch(
      "*** Add File: add.txt", "+added",
      "*** Update File: update.txt", "*** Move to: moved.txt", "@@ section", "-old", "+new",
      "*** Delete File: delete.txt",
    ))).toEqual([
      { type: "add", path: "add.txt", contents: "added" },
      {
        type: "update", path: "update.txt", movePath: "moved.txt",
        chunks: [{ oldLines: ["old"], newLines: ["new"], changeContext: "section", endOfFile: undefined }],
      },
      { type: "delete", path: "delete.txt" },
    ]);
  });

  test("strips an official heredoc wrapper and permits surrounding text", () => {
    const input = patch("*** Add File: a", "+added");
    expect(Patch.parse(`cat <<'EOF'\n${input}\nEOF`)).toEqual(Patch.parse(input));
    expect(Patch.parse(`<<PATCH\n${input}\nPATCH`)).toEqual(Patch.parse(input));
    expect(Patch.parse(`Here is the patch:\n${input}\nDone.`)).toEqual(Patch.parse(input));
  });

  test("parses EOF markers inside update chunks", () => {
    expect(Patch.parse(update("@@", "-last", "+end", "*** End of File"))).toEqual([{
      type: "update", path: "a", movePath: undefined,
      chunks: [{ oldLines: ["last"], newLines: ["end"], changeContext: undefined, endOfFile: true }],
    }]);
  });

  const invalid: Array<[string, string, string]> = [
    ["missing envelope", "not a patch", "Invalid patch format: missing Begin/End markers"],
    ["reversed envelope", "*** End Patch\n*** Begin Patch", "Invalid patch format"],
    ["empty add path", patch("*** Add File:", "+a"), "Invalid add file path"],
    ["empty update path", patch("*** Update File:", "@@", "+a"), "Invalid update file path"],
    ["empty delete path", patch("*** Delete File:"), "Invalid delete file path"],
    ["empty move path", update("*** Move to:", "@@", "+a"), "Invalid move file path"],
    ["unprefixed add line", patch("*** Add File: a", "missing plus"), "Invalid add file line: missing plus"],
    ["missing update chunk", update(), "Invalid update hunk for a: expected at least one @@ chunk"],
    ["missing @@", update("-old", "+new"), "Invalid update file line: -old"],
    ["unprefixed update line", update("@@", "unprefixed"), "Invalid update chunk line: unprefixed"],
    ["unexpected delete body", patch("*** Delete File: a", "unexpected body"), "Invalid patch line: unexpected body"],
    ["unknown operation", patch("*** Rename File: a"), "Invalid patch line: *** Rename File: a"],
    ["misplaced move", patch("*** Add File: a", "+a", "*** Move to: b"), "Invalid patch line: *** Move to: b"],
  ];
  for (const [name, input, error] of invalid) {
    test(`rejects ${name} with the official error before snapshotting`, async () => {
      expect(() => Patch.parse(input)).toThrow(error);
      const fs = memory({ a: "old\n" });
      await expect(planPatch(input, fs.options)).rejects.toThrow(`apply_patch verification failed: Error: ${error}`);
      expect(fs.reads).toEqual([]);
    });
  }

  test("@@ text is a literal change context, not a unified-diff line number", async () => {
    const fs = memory({ a: "old\n" });
    await expect(planPatch(update("@@ -1 +1 @@", "-old", "+new"), fs.options)).rejects.toThrow(
      "Failed to find context '-1 +1 @@' in /remote/a",
    );
  });

  test("rejects empty patches at the adapter boundary", async () => {
    const fs = memory();
    await expect(planPatch(" \n", fs.options)).rejects.toThrow("patchText is required");
    await expect(planPatch(patch(), fs.options)).rejects.toThrow("patch rejected: empty patch");
    expect(fs.reads).toEqual([]);
  });
});

describe("official hunk matching and content semantics", () => {
  test("updates multiple chunks against original line positions", async () => {
    expect(await contents("line 1\nline 2\nline 3\nline 4\n",
      "@@", " line 1", "-line 2", "+LINE 2", "+extra",
      "@@", " line 3", "-line 4", "+LINE 4",
    )).toBe("line 1\nLINE 2\nextra\nline 3\nLINE 4\n");
  });

  test("seeks change context before matching and advances monotonically", async () => {
    expect(await contents("first\nold\nsecond\nold\nthird\nold\n",
      "@@ second", "-old", "+SECOND", "@@", "-old", "+THIRD",
    )).toBe("first\nold\nsecond\nSECOND\nthird\nTHIRD\n");
  });

  test("prioritizes exact matches over earlier fuzzy matches", async () => {
    expect(await contents("old  \n  old\nold\n", "@@", "-old", "+new"))
      .toBe("old  \n  old\nnew\n");
  });

  test("prioritizes trailing-whitespace matching before full trim", async () => {
    expect(await contents("  old\nold  \n", "@@", "-old", "+new")).toBe("  old\nnew\n");
  });

  test("falls back to trimming both ends", async () => {
    expect(await contents("\t  old  \n", "@@", "- old", "+new")).toBe("new\n");
  });

  test("normalizes official Unicode punctuation and nonbreaking spaces", async () => {
    expect(await contents("‘single’ “double” – …\u00a0end\n", "@@", "-'single' \"double\" - ... end", "+new"))
      .toBe("new\n");
  });

  test("uses the same fuzzy matching for @@ change context", async () => {
    expect(await contents("  “section”  \nold\n", "@@ \"section\"", "-old", "+new"))
      .toBe("  “section”  \nnew\n");
  });

  test("EOF prefers the last matching sequence", async () => {
    expect(await contents("marker\nend\nmarker\nend\n",
      "@@", "-marker", "+changed", " end", "*** End of File",
    )).toBe("marker\nend\nchanged\nend\n");
  });

  test("EOF still falls back to a forward match", async () => {
    expect(await contents("marker\nend\nother\n",
      "@@", "-marker", "+changed", " end", "*** End of File",
    )).toBe("changed\nend\nother\n");
  });

  test("EOF tries exact forward matches before fuzzy end matches", async () => {
    expect(await contents("old\nold  \n", "@@", "-old", "+new", "*** End of File"))
      .toBe("new\nold  \n");
  });

  test("retries without trailing empty context at EOF", async () => {
    expect(await contents("old", "@@", "-old", "+new", " ")).toBe("new\n");
  });

  test("pure additions append, even after @@ context, in chunk order", async () => {
    expect(await contents("section\nold\n", "@@ section", "+first", "@@", "+second"))
      .toBe("section\nold\nfirst\nsecond\n");
  });

  test("core pure addition retains a pre-existing final blank line", async () => {
    expect(await contents("old\n\n", "@@", "+new")).toBe("old\n\nnew\n");
  });

  test("handles empty files and missing final newlines", async () => {
    expect(await contents("", "@@", "+First line")).toBe("First line\n");
    expect(await contents("no newline", "@@", "-no newline", "+has newline now")).toBe("has newline now\n");
    expect(await contents("old", "@@", " old")).toBe("old\n");
  });

  test("preserves the official removal and trailing-blank-line behavior", async () => {
    expect(await contents("old\n", "@@", "-old")).toBe("");
    expect(await contents("old\n\n", "@@", "-old", "+new")).toBe("new\n");
  });

  test("preserves or introduces BOM using the official derive/joinBom", async () => {
    const derived = Patch.derive("a", [{ oldLines: ["  old   "], newLines: ["new"] }], "\uFEFFold\n");
    expect(derived).toEqual({ content: "new\n", bom: true });
    expect(Patch.joinBom(derived.content, derived.bom)).toBe("\uFEFFnew\n");
    expect(await contents("\uFEFFold\n", "@@", "-old", "+new")).toBe("\uFEFFnew\n");
    expect(await contents("old\n", "@@", "-old", "+\uFEFFnew")).toBe("\uFEFFnew\n");
    expect(await contents("\uFEFFold\n", "@@", "-old")).toBe("\uFEFF");
  });

  test("does not normalize CRLF files when applying LF hunks", async () => {
    expect(await contents("first\r\nold\r\nlast\r\n", "@@", "-old", "+new"))
      .toBe("first\r\nnew\nlast\r\n");
  });

  test("preserves CRLF patch contents, including the official strict EOF spelling", async () => {
    const fs = memory({ a: "old\r\n" });
    const input = update("@@", "-old", "+new").replaceAll("\n", "\r\n");
    expect((await planPatch(input, fs.options)).changes[0]!.content).toBe("new\r\n");
    const eof = update("@@", "-old", "+new", "*** End of File").replaceAll("\n", "\r\n");
    await expect(planPatch(eof, fs.options)).rejects.toThrow("Invalid patch line: *** End of File\r");
  });

  test("reports unmatched context and expected lines exactly", async () => {
    const fs = memory({ a: "old\n" });
    await expect(planPatch(update("@@ missing", "-old", "+new"), fs.options)).rejects.toThrow(
      "apply_patch verification failed: Error: Failed to find context 'missing' in /remote/a",
    );
    await expect(planPatch(update("@@", "-different", "+new"), fs.options)).rejects.toThrow(
      "apply_patch verification failed: Error: Failed to find expected lines in /remote/a:\ndifferent",
    );
  });

  test("later @@ chunks cannot match lines inserted by earlier chunks", async () => {
    const fs = memory({ a: "old\n" });
    await expect(planPatch(update("@@", "-old", "+new", "@@", "-new", "+newer"), fs.options))
      .rejects.toThrow("Failed to find expected lines in /remote/a:\nnew");
    expect(fs.stored.get("/remote/a")!.content).toBe("old\n");
  });
});

describe("read-only versioned filesystem planning", () => {
  test("plans add/update/delete/move and nested paths together without writes", async () => {
    const fs = memory({ update: "old\n", delete: "remove\n", source: "\uFEFFmove\n" });
    const before = [...fs.stored];
    const result = await planPatch(patch(
      "*** Add File: deep/nested/new", "+hello", "+world",
      "*** Update File: update", "@@", "-old", "+new",
      "*** Delete File: delete",
      "*** Update File: source", "*** Move to: destination", "@@", "-move", "+moved",
    ), fs.options);
    expect(result).toEqual({
      changes: [
        { path: "/remote/deep/nested/new", version: null, content: "hello\nworld\n" },
        { path: "/remote/update", version: "initial:/remote/update", content: "new\n" },
        { path: "/remote/delete", version: "initial:/remote/delete", content: null },
        { path: "/remote/source", version: "initial:/remote/source", content: null },
        { path: "/remote/destination", version: null, content: "\uFEFFmoved\n" },
      ],
      files: [
        { path: "/remote/deep/nested/new", type: "add" },
        { path: "/remote/update", type: "update" },
        { path: "/remote/delete", type: "delete" },
        { path: "/remote/source", type: "move", movePath: "/remote/destination" },
      ],
    });
    expect([...fs.stored]).toEqual(before);
  });

  test("uses official add-file newline, empty-file, CRLF, and BOM semantics", async () => {
    const fs = memory();
    const result = await planPatch(patch(
      "*** Add File: empty",
      "*** Add File: blank", "+",
      "*** Add File: newline", "+", "+",
      "*** Add File: trailing", "+line", "+", "+",
      "*** Add File: bom", "+\uFEFFtext",
      "*** Add File: crlf", "+one\r", "+two\r",
    ), fs.options);
    expect(result.changes.map((change) => change.content)).toEqual(["", "", "\n", "line\n\n", "\uFEFFtext\n", "one\r\ntwo\r\n"]);
  });

  test("adds and moves overwrite existing destinations with original versions", async () => {
    const fs = memory({ a: "previous add", source: "source\n", destination: "previous destination" });
    const result = await planPatch(patch(
      "*** Add File: a", "+replacement",
      "*** Update File: source", "*** Move to: destination", "@@", " source",
    ), fs.options);
    expect(result.changes).toEqual([
      { path: "/remote/a", version: "initial:/remote/a", content: "replacement\n" },
      { path: "/remote/source", version: "initial:/remote/source", content: null },
      { path: "/remote/destination", version: "initial:/remote/destination", content: "source\n" },
    ]);
    expect(fs.stored.get("/remote/destination")!.content).toBe("previous destination");
  });

  test("maps every source and move path through the supplied remote resolver before reading", async () => {
    const mapped: string[] = [];
    const fs = memory({ a: "old\n", gone: "gone\n" }, (path) => remotePath("/srv/project", path, "/Users/j/project"));
    const originalSnapshot = fs.options.snapshot;
    const result = await planPatch(patch(
      "*** Add File: /Users/j/project/new", "+new",
      "*** Update File: ./a", "*** Move to: ../shared/a", "@@", "-old", "+moved",
      "*** Delete File: /srv/project/gone",
    ), {
      resolvePath: (path) => {
        mapped.push(path);
        return fs.options.resolvePath(path);
      },
      snapshot: (path) => {
        expect(mapped).toEqual(["/Users/j/project/new", "./a", "../shared/a", "/srv/project/gone"]);
        return originalSnapshot(path);
      },
    });
    expect(result.files).toEqual([
      { path: "/srv/project/new", type: "add" },
      { path: "/srv/project/a", type: "move", movePath: "/srv/shared/a" },
      { path: "/srv/project/gone", type: "delete" },
    ]);
    expect(fs.reads).toEqual(["/srv/project/new", "/srv/project/a", "/srv/shared/a", "/srv/project/gone"]);
  });

  test("composes repeated mapped updates and snapshots each identity only once", async () => {
    const fs = memory({ a: "old\n" });
    const result = await planPatch(patch(
      "*** Update File: a", "@@", "-old", "+intermediate",
      "*** Update File: ./a", "@@", "-intermediate", "+final",
    ), fs.options);
    expect(result.changes).toEqual([{ path: "/remote/a", version: "initial:/remote/a", content: "final\n" }]);
    expect(fs.reads).toEqual(["/remote/a"]);
  });

  test("composes add/update/move/update without deleting a source initially absent", async () => {
    const fs = memory();
    const result = await planPatch(patch(
      "*** Add File: a", "+one",
      "*** Update File: a", "@@", "-one", "+two",
      "*** Update File: a", "*** Move to: b", "@@", " two",
      "*** Update File: b", "@@", "-two", "+three",
    ), fs.options);
    expect(result.changes).toEqual([{ path: "/remote/b", version: null, content: "three\n" }]);
    expect(fs.reads).toEqual(["/remote/a", "/remote/b"]);
  });

  test("composes delete/add and retains the initial existing version", async () => {
    const fs = memory({ a: "old\n" });
    const result = await planPatch(patch("*** Delete File: a", "*** Add File: a", "+new"), fs.options);
    expect(result.changes).toEqual([{ path: "/remote/a", version: "initial:/remote/a", content: "new\n" }]);
    expect(fs.reads).toEqual(["/remote/a"]);
  });

  test("composes chained moves sequentially including overwritten intermediate files", async () => {
    const fs = memory({ a: "original\n", b: "overwritten\n", c: "also overwritten\n" });
    const result = await planPatch(patch(
      "*** Update File: a", "*** Move to: b", "@@", " original",
      "*** Update File: b", "*** Move to: c", "@@", "-original", "+final",
    ), fs.options);
    expect(result.changes).toEqual([
      { path: "/remote/a", version: "initial:/remote/a", content: null },
      { path: "/remote/b", version: "initial:/remote/b", content: null },
      { path: "/remote/c", version: "initial:/remote/c", content: "final\n" },
    ]);
  });

  test("omits an absent-to-absent net change", async () => {
    const result = await planPatch(patch("*** Add File: a", "+temporary", "*** Delete File: a"), memory().options);
    expect(result.changes).toEqual([]);
    expect(result.files).toEqual([{ path: "/remote/a", type: "add" }, { path: "/remote/a", type: "delete" }]);
  });

  test("retains source and destination versions if external state changes after snapshots", async () => {
    const fs = memory({ a: "old\n", b: "destination\n" });
    const snapshot = fs.options.snapshot;
    const result = await planPatch(patch(
      "*** Update File: a", "*** Move to: b", "@@", "-old", "+new",
      "*** Update File: b", "@@", "-new", "+final",
    ), {
      ...fs.options,
      snapshot: async (path) => {
        const initial = await snapshot(path);
        fs.stored.set(path, { ...initial, content: "concurrent edit\n", version: "external-change" });
        return initial;
      },
    });
    expect(result.changes).toEqual([
      { path: "/remote/a", version: "initial:/remote/a", content: null },
      { path: "/remote/b", version: "initial:/remote/b", content: "final\n" },
    ]);
    expect(fs.reads).toEqual(["/remote/a", "/remote/b"]);
    expect(fs.stored.get("/remote/a")!.content).toBe("concurrent edit\n");
    expect(fs.stored.get("/remote/b")!.content).toBe("concurrent edit\n");
  });

  test("an invalid later file body rejects the full patch before any snapshots", async () => {
    const fs = memory();
    await expect(planPatch(patch("*** Add File: a", "+valid", "*** Add File: b", "invalid"), fs.options))
      .rejects.toThrow("Invalid add file line");
    expect(fs.reads).toEqual([]);
    expect([...fs.stored]).toEqual([]);
  });

  test("a later unmatched hunk returns no partial plan and leaves snapshots untouched", async () => {
    const fs = memory({ b: "old\n" });
    const before = [...fs.stored];
    await expect(planPatch(patch(
      "*** Add File: a", "+valid", "*** Update File: b", "@@", "-absent", "+invalid",
    ), fs.options)).rejects.toThrow("Failed to find expected lines");
    expect(fs.reads).toEqual(["/remote/a", "/remote/b"]);
    expect([...fs.stored]).toEqual(before);
  });

  test("fails missing updates, deletes, move sources, and update-after-delete", async () => {
    const fs = memory({ a: "old\n" });
    for (const input of [
      patch("*** Update File: missing", "@@", "+new"),
      patch("*** Delete File: missing"),
      patch("*** Update File: missing", "*** Move to: target", "@@", "+new"),
      patch("*** Delete File: a", "*** Update File: a", "@@", "+new"),
      patch("*** Delete File: a", "*** Delete File: a"),
    ]) {
      await expect(planPatch(input, fs.options)).rejects.toThrow("Failed to read file to");
    }
    expect(fs.stored.get("/remote/a")!.content).toBe("old\n");
  });

  test("rejects self-moves after alias resolution without snapshots", async () => {
    const fs = memory({ a: "old\n" });
    await expect(planPatch(update("*** Move to: ./a", "@@", " old"), fs.options))
      .rejects.toThrow("source and destination resolve to the same path");
    expect(fs.reads).toEqual([]);
  });

  test("rejects file/descendant conflicts including move destinations before snapshots", async () => {
    const fs = memory({ a: "old\n" });
    await expect(planPatch(patch("*** Add File: dir", "+a", "*** Add File: dir/child", "+b"), fs.options))
      .rejects.toThrow("Conflicting patch paths");
    await expect(planPatch(update("*** Move to: a/child", "@@", " old"), fs.options))
      .rejects.toThrow("Conflicting patch paths");
    expect(fs.reads).toEqual([]);
  });

  test("propagates resolver and snapshot failures without mutations", async () => {
    const fs = memory();
    await expect(planPatch(patch("*** Add File: a", "+valid", "*** Delete File: blocked"), {
      ...fs.options,
      resolvePath: (path) => {
        if (path === "blocked") throw new Error("mapping rejected");
        return fs.options.resolvePath(path);
      },
    })).rejects.toThrow("mapping rejected");
    expect(fs.reads).toEqual([]);
    await expect(planPatch(patch("*** Add File: a", "+valid"), {
      ...fs.options, snapshot: async () => { throw new Error("read failed"); },
    })).rejects.toThrow("read failed");
    expect([...fs.stored]).toEqual([]);
  });

  test("rejects inconsistent snapshot identities or existence/version pairs", async () => {
    for (const initial of [
      { path: "/different", content: "", exists: false, version: null },
      { path: "/remote/a", content: "", exists: true, version: null },
      { path: "/remote/a", content: "", exists: false, version: "version" },
    ]) {
      await expect(planPatch(patch("*** Add File: a", "+new"), {
        resolvePath: () => "/remote/a", snapshot: async () => initial,
      })).rejects.toThrow("Inconsistent patch snapshot");
    }
  });
});

describe("bounded patch planning", () => {
  const ceiling = 10 * 1024 * 1024;

  test("rejects oversized UTF-8 patch input before resolving or reading", async () => {
    const fs = memory();
    await expect(planPatch(patch("*** Add File: a", `+${"界".repeat(Math.ceil(ceiling / 3))}`), fs.options))
      .rejects.toThrow("patchText exceeds the 10 MiB");
    expect(fs.reads).toEqual([]);
  });

  test("rejects oversized individual snapshots and aggregate snapshot content", async () => {
    const large = memory({ a: "x".repeat(ceiling + 1) });
    await expect(planPatch(patch("*** Delete File: a"), large.options)).rejects.toThrow("Snapshot /remote/a exceeds");
    const many = memory({ a: "x".repeat(ceiling / 2 + 1), b: "y".repeat(ceiling / 2) });
    await expect(planPatch(patch("*** Delete File: a", "*** Delete File: b"), many.options))
      .rejects.toThrow("Patch snapshots exceed the 10 MiB");
  });

  test("permits a 10 MiB output and rejects growth beyond the ceiling", async () => {
    const accepted = memory({ a: "x".repeat(ceiling - 3) });
    const result = await planPatch(update("@@", "+y"), accepted.options);
    expect(Buffer.byteLength(result.changes[0]!.content!)).toBe(ceiling);
    const rejected = memory({ a: "x".repeat(ceiling - 2) });
    await expect(planPatch(update("@@", "+y"), rejected.options)).rejects.toThrow("Patched file /remote/a exceeds");
  });

  test("bounds aggregate overlay growth across different paths", async () => {
    const half = "x".repeat(ceiling / 2 - 1);
    const fs = memory({ a: half, b: half });
    await expect(planPatch(patch(
      "*** Update File: a", "@@", "+y", "*** Update File: b", "@@", "+z",
    ), fs.options)).rejects.toThrow("Patch overlay exceeds the 10 MiB");
  });

  test("bounds line arrays before invoking the unmodified upstream engine", async () => {
    const fs = memory();
    await expect(planPatch(patch("*** Add File: a", ...Array<string>(50_000).fill("+x")), fs.options))
      .rejects.toThrow("50000 line patch edit limit");
    expect(fs.reads).toEqual([]);
    const manyLines = memory({ a: "\n".repeat(50_000) });
    await expect(planPatch(patch("*** Delete File: a"), manyLines.options)).rejects.toThrow("50000 line patch edit limit");
  });

  test("supports large bounded insertions without spread argument overflow", async () => {
    const fs = memory({ a: "old\n" });
    const additions = Array<string>(40_000).fill("+x");
    const result = await planPatch(update("@@", ...additions), fs.options);
    expect(result.changes[0]!.content).toBe(`old\n${"x\n".repeat(40_000)}`);
  });

  test("bounds distinct resolved targets before reading", async () => {
    const fs = memory();
    const lines = Array.from({ length: 1_025 }, (_, index) => `*** Add File: file-${index}`);
    await expect(planPatch(patch(...lines), fs.options)).rejects.toThrow("1024 path edit limit");
    expect(fs.reads).toEqual([]);
  });
});

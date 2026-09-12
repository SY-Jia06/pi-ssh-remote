import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { editContent, newFileContent } from "../edit-file.js";

describe("OpenCode 1.18.30 edit semantics", () => {
  test("missing-file content preserves newlines and follows native BOM split/join", () => {
    expect(newFileContent("first\r\nsecond")).toBe("first\r\nsecond");
    expect(newFileContent("\uFEFFtext")).toBe("\uFEFFtext");
    expect(newFileContent("\uFEFF\uFEFFtext")).toBe("\uFEFFtext");
  });
  test("vendored pure logic is byte-identical to the pinned upstream excerpt", () => {
    // Verified against GitHub contents API at commit 3104c1428ec91f809e5ab86631300de41eb6952e.
    // Excerpt: [export type Replacer, export function trimDiff) + [export function replace, EOF).
    const source = readFileSync(new URL("../vendor/opencode-edit.ts", import.meta.url), "utf8");
    const pure = source.slice(source.indexOf("export type Replacer"));
    expect(createHash("sha256").update(pure).digest("hex")).toBe(
      "2039b8a17dd6c68a4510ec213432136c5ef433de3fa92af414c63a6421c6b292",
    );
  });

  test("exact matching requires uniqueness, including overlapping matches", () => {
    expect(editContent("one two", "one", "ONE")).toBe("ONE two");
    expect(() => editContent("one one", "one", "ONE")).toThrow("Found multiple matches for oldString.");
    expect(() => editContent("aaa", "aa", "X")).toThrow("Found multiple matches for oldString.");
    expect(editContent("one one", "one", "ONE", true)).toBe("ONE ONE");
    expect(editContent("aaa", "aa", "X", true)).toBe("Xa");
  });

  test("uses official fallback order and scope for replaceAll", () => {
    expect(editContent("  alpha \n  beta \ntail", "alpha\nbeta", "next")).toBe("next\ntail");
    expect(editContent("prefix(a,   b) suffix", "(a, b)", "X")).toBe("prefixX suffix");
    expect(editContent("alpha\nbeta", "alpha\\nbeta", "next")).toBe("next");
    expect(editContent("before alpha after", "\nalpha\n", "X")).toBe("before X after");
    // replaceAll replaces the selected search span, not every whitespace-equivalent variant.
    expect(editContent("alpha   beta\nalpha beta", "alpha beta", "X", true)).toBe("alpha   beta\nX");
  });

  test("keeps upstream literal single replacement and JS replaceAll dollar expansion", () => {
    const replacement = "$$:$&:$`: $'";
    expect(editContent("aXb", "X", replacement)).toBe(`a${replacement}b`);
    expect(editContent("aXbXc", "X", replacement, true)).toBe("aXbXc".replaceAll("X", replacement));
  });

  test("preserves anchor similarity thresholds and disproportionate-span rejection", () => {
    expect(editContent("begin\n  enabled = true\nend", "begin\n  enabled = ture\nend", "new")).toBe("new");
    expect(() => editContent(
      "function configure() {\n  removeAllUserData()\n}",
      "function configure() {\n  const enabled = true\n}", "new",
    )).toThrow("Could not find oldString");
    expect(() => editContent(
      `A\nsame1\nsame2\n${"h".repeat(600)}\nZ`, "A\nsame1\nsame2\nx\nZ", "new",
    )).toThrow("matched span is much larger");
    expect(() => editContent("actual content", "not in this file", "new")).toThrow("Could not find oldString");
  });

  test("empty oldString represents an existing file, never file creation", () => {
    for (const content of ["", "existing", "\uFEFF"]) {
      expect(() => editContent(content, "", "new")).toThrow("oldString cannot be empty when editing an existing file.");
      expect(() => editContent(content, "", "")).toThrow("oldString and newString are identical.");
    }
  });

  test("checks no-op before and after newline normalization, but allows upstream fuzzy no-op", () => {
    expect(() => editContent("content", "same", "same")).toThrow("identical.");
    expect(() => editContent("a\nb", "a\r\nb", "a\nb")).toThrow("identical.");
    expect(editContent("alpha   beta", "alpha beta", "alpha   beta")).toBe("alpha   beta");
  });

  for (const ending of ["\n", "\r\n"]) {
    for (const inputEnding of ["\n", "\r\n"]) {
      test(`preserves ${JSON.stringify(ending)} with ${JSON.stringify(inputEnding)} arguments`, () => {
        const content = ["alpha", "beta", "gamma", ""].join(ending);
        expect(editContent(content, ["alpha", "beta"].join(inputEnding), ["alpha", "BETA"].join(inputEnding)))
          .toBe(["alpha", "BETA", "gamma", ""].join(ending));
        expect(editContent(["a", "b", "a", "b"].join(ending), "a\nb", "c\r\nd", true))
          .toBe(["c", "d", "c", "d"].join(ending));
      });
    }
  }

  test("does not append a newline or normalize untouched mixed source endings", () => {
    expect(editContent("one", "one", "two")).toBe("two");
    expect(editContent("one\ntwo\r\nthree", "three", "THREE\nFOUR")).toBe("one\ntwo\r\nTHREE\r\nFOUR");
    expect(editContent("one\rtwo", "two", "THREE\nFOUR")).toBe("one\rTHREE\nFOUR");
  });

  test("preserves the official BOM split/join behavior", () => {
    expect(editContent("\uFEFFusing System;\n", "using System;", "using Up;")).toBe("\uFEFFusing Up;\n");
    expect(editContent("old", "old", "\uFEFFnew")).toBe("\uFEFFnew");
    expect(editContent("\uFEFFold", "old", "\uFEFF\uFEFFnew")).toBe("\uFEFFnew");
    expect(editContent("\uFEFFold", "old", "")).toBe("\uFEFF");
  });
});

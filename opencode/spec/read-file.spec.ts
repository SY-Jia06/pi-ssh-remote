import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OpenSshPool, type ParsedSsh, type RunOptions, type RunResult, tailText } from "../core.js";
import { readRemoteFile } from "../read-file.js";

const target = { target: "local-test-only" } as ParsedSsh;
const defaults = { offset: 1, limit: 400, maxBytes: 16 * 1024 };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
let directory: string;
let calls: RunOptions[];

// Real ephemeral python3 execution through a local shell. No SSH process/config.
const pool = {
  async run(_target: ParsedSsh, command: string, options: RunOptions): Promise<RunResult> {
    calls.push(options);
    return new Promise((resolve, reject) => {
      const child = spawn("/bin/bash", ["-c", `exec ${command}`], { stdio: "pipe", signal: options.signal });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const output = Buffer.concat(chunks).toString("utf8");
        const totalLines = output ? output.replace(/\n$/, "").split("\n").length : 0;
        const totalBytes = Buffer.byteLength(output);
        const truncated = totalBytes > options.maxBytes! || totalLines > options.maxLines!;
        resolve({
          output: truncated ? tailText(output, options.maxLines!, options.maxBytes!) : output,
          exitCode: code ?? 124, totalLines, totalBytes, truncated, timedOut: signal === "SIGKILL",
        });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    });
  },
} as unknown as OpenSshPool;

function file(name: string, content: string | Buffer): string {
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}

function sparse(name: string, prefix: Buffer, size: number): string {
  const path = join(directory, name);
  const fd = openSync(path, "w");
  try {
    writeSync(fd, prefix);
    ftruncateSync(fd, size);
    writeSync(fd, Buffer.from("TAIL_SENTINEL\n"), 0, 14, size - 14);
  } finally {
    closeSync(fd);
  }
  return path;
}

function read(path: string, options: Partial<typeof defaults> = {}) {
  return readRemoteFile(pool, target, path, { ...defaults, ...options });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "opencode-read-spec-"));
  calls = [];
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("remote read rendering and bounds", () => {
  test("renders native line numbers and EOF for unterminated and terminated text", async () => {
    for (const ending of ["", "\n", "\r\n"]) {
      const path = file("hello.txt", `first\r\n第二😀${ending}`);
      const result = await read(path);
      expect(result.output).toBe(`<path>${path}</path>\n<type>file</type>\n<content>\n1: first\n2: 第二😀\n\n(End of file - total 2 lines)\n</content>`);
      expect(result.metadata.display).toMatchObject({ text: "first\n第二😀", lineStart: 1, lineEnd: 2, totalLines: 2, truncated: false });
      expect(result.metadata.loaded).toEqual([]);
    }
  });

  test("removes only an initial UTF-8 BOM and preserves blank lines and bare CR", async () => {
    const result = await read(file("bom.txt", "\uFEFFfirst\n\n\uFEFFlast\rpart\n"));
    expect(result.metadata.preview).toBe("first\n\n\uFEFFlast\rpart");
    expect(result.metadata.display).toMatchObject({ totalLines: 3 });
  });

  test("uses replacement decoding for invalid UTF-8, including an incomplete EOF scalar", async () => {
    const result = await read(file("invalid.txt", Buffer.from([0x61, 0xff, 0x62, 0xe2, 0x82])));
    expect(result.metadata.preview).toBe("a�b�");
  });

  test("honors offset and line limit without inventing a total", async () => {
    const path = file("lines.txt", "one\ntwo\nthree\nfour\nfive\n");
    const result = await read(path, { offset: 2, limit: 2 });
    expect(result.metadata.preview).toBe("two\nthree");
    expect(result.output).toContain("2: two\n3: three");
    expect(result.output).toContain("Total line count unknown. Use offset=4");
    expect(result.metadata).toMatchObject({ truncated: true, nextOffset: 4, display: { totalLines: null } });
    const end = await read(path, { offset: 4, limit: 2 });
    expect(end.metadata).toMatchObject({ truncated: false, display: { totalLines: 5 } });
    expect(end.output).toContain("End of file - total 5 lines");
  });

  test("handles empty files, zero offset/limit, and exact out-of-range errors", async () => {
    const empty = file("empty.txt", "");
    expect((await read(empty)).output).toContain("End of file - total 0 lines");
    await expect(read(empty, { offset: 2 })).rejects.toThrow("Offset 2 is out of range for this file (0 lines)");
    const path = file("three.txt", "one\ntwo\nthree\n");
    await expect(read(path, { offset: 4 })).rejects.toThrow("Offset 4 is out of range for this file (3 lines)");
    expect((await read(path, { offset: 0 })).output).toContain("1: one");
    const none = await read(path, { limit: 0 });
    expect(none.metadata).toMatchObject({ preview: "", truncated: true, nextOffset: 1 });
    expect(none.output).toContain("positive limit");
    expect(none.output).not.toContain("1-0");
  });

  test("caps complete lines by bytes and gives the correct next offset", async () => {
    const path = file("budget.txt", "alpha\nbeta\ngamma\n");
    for (const maxBytes of [6, 8]) {
      const result = await read(path, { maxBytes });
      expect(result.metadata).toMatchObject({ preview: "alpha", truncated: true, nextOffset: 2, incompleteLine: null });
      expect(result.output).toContain(`Output capped at ${maxBytes} bytes`);
      expect(result.output).not.toContain("2: beta");
      expect(result.output).not.toContain("End of file");
    }
  });

  test("clips a byte-limited UTF-8 prefix without corruption or skipping its remainder", async () => {
    const result = await read(file("unicode.txt", "你😀好\nnext\n"), { maxBytes: 5 });
    expect(result.metadata).toMatchObject({ preview: "你", incompleteLine: 1, nextOffset: 1, truncated: true });
    expect(result.output).not.toContain("�");
    expect(result.output).toContain("line 1 is incomplete");
    expect(result.output).toContain("configured readMaxBytes budget");
    expect(result.output).toContain("focused byte range via remote_bash");
    expect(result.output).toContain("offset=2 to skip this line's remaining text if another line exists");
    expect(result.output).toContain("still scans the prefix");
    expect(result.output).not.toContain("larger maxBytes");
  });

  test("truncates long lines at 2000 UTF-16 units and continues with the next real line", async () => {
    const result = await read(file("long.txt", "x".repeat(3000) + "\nnext\n"));
    expect(result.metadata.preview).toBe("x".repeat(2000) + "... (line truncated to 2000 chars)\nnext");
    expect(result.metadata).toMatchObject({ truncated: false, longLinesTruncated: [1], display: { totalLines: 2 } });
    const unicode = await read(file("long-unicode.txt", "x".repeat(1999) + "😀" + "z".repeat(100)));
    expect(unicode.metadata.preview).toBe("x".repeat(1999) + "... (line truncated to 2000 chars)");
  });

  test("does not scan the remainder of a multi-GB log or giant single line", async () => {
    const path = sparse("huge.log", Buffer.from("FIRST\n" + "x".repeat(128 * 1024)), 4 * 1024 ** 3);
    const first = await read(path, { limit: 1 });
    expect(first.metadata).toMatchObject({ preview: "FIRST", truncated: true, nextOffset: 2, display: { totalLines: null } });
    expect(first.metadata.bytesRead as number).toBeLessThan(5000);
    expect(first.output).not.toContain("TAIL_SENTINEL");
    const hugeLine = await read(path, { offset: 2 });
    expect(hugeLine.metadata).toMatchObject({ truncated: true, incompleteLine: 2, nextOffset: 2, display: { totalLines: null } });
    expect(hugeLine.metadata.bytesRead as number).toBeLessThan(25 * 1024);
    expect(hugeLine.output).not.toContain("End of file");
  });

  test("quotes shell metacharacters, whitespace, and newlines in paths", async () => {
    const result = await read(file("a '\";$(false)\n汉字.txt", "safe"));
    expect(result.metadata.preview).toBe("safe");
    expect(calls[0]?.useRemoteTimeout).toBe(false);
    expect(calls[0]?.input).toBeString();
  });
});

describe("remote directories and attachments", () => {
  test("sorts and paginates directory entries, including directory symlinks", async () => {
    file("z.txt", "z");
    file("a.txt", "a");
    mkdirSync(join(directory, "folder"));
    symlinkSync(join(directory, "folder"), join(directory, "link"));
    symlinkSync(join(directory, "missing"), join(directory, "broken"));
    const page = await read(directory, { offset: 2, limit: 2 });
    expect(page.metadata).toMatchObject({ preview: "broken\nfolder/", truncated: true, nextOffset: 4 });
    expect(page.output).toContain("<type>directory</type>");
    expect(page.output).not.toContain("2: broken");
    const end = await read(directory, { offset: 4, limit: 2 });
    expect(end.metadata.display).toMatchObject({ entries: ["link/", "z.txt"], totalEntries: 5, truncated: false });
    expect((await read(directory, { offset: 99 })).metadata.truncated).toBe(false);
  });

  test("bounds directory output by whole entries", async () => {
    file("alpha", "");
    file("beta", "");
    const result = await read(directory, { maxBytes: 5 });
    expect(result.metadata).toMatchObject({ preview: "alpha", truncated: true, nextOffset: 2 });
    await expect(read(directory, { maxBytes: 1 })).rejects.toThrow("Directory entry exceeds configured readMaxBytes budget");
  });

  for (const [name, content, mime] of [
    ["image.png", png, "image/png"],
    ["image.bin", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), "image/jpeg"],
    ["animated.data", Buffer.from("GIF89a"), "image/gif"],
    ["web.data", Buffer.from("RIFFxxxxWEBP"), "image/webp"],
    ["paper.unknown", Buffer.from("%PDF-1.7\nhello"), "application/pdf"],
  ] as const) {
    test(`attaches ${mime} using signature detection before binary rejection`, async () => {
      const result = await read(file(name, content), { maxBytes: 1 });
      expect(result.attachments).toEqual([{ type: "file", mime, url: `data:${mime};base64,${content.toString("base64")}` }]);
      expect(result.output).toBe(mime === "application/pdf" ? "PDF read successfully" : "Image read successfully");
      expect(result.metadata.truncated).toBe(false);
    });
  }

  test("reads SVG and unsupported image formats as text when they are not binary", async () => {
    for (const [name, content] of [["image.svg", "<svg/>"], ["image.bmp", "BM text"], ["schema.fbs", "table X {}"]]) {
      const result = await read(file(name!, content!));
      expect(result.attachments).toBeUndefined();
      expect(result.metadata.preview).toBe(content!);
    }
  });

  test("allows exactly 10 MiB but rejects larger attachments before transfer", async () => {
    const exact = sparse("exact.png", png, 10 * 1024 ** 2);
    const result = await read(exact);
    expect(Buffer.from(result.attachments![0]!.url.split(",")[1]!, "base64").length).toBe(10 * 1024 ** 2);
    await expect(read(sparse("large.png", png, 10 * 1024 ** 2 + 1))).rejects.toThrow("Attachment exceeds 10 MiB limit");
  });

  test("enforces the attachment limit even if the file grows after stat", async () => {
    const growingPool = {
      run(target: ParsedSsh, command: string, options: RunOptions) {
        return pool.run(target, command, {
          ...options,
          input: String(options.input).replace(
            "data = file.read(attachment_limit + 1)",
            'with open(path, "ab") as growing:\n                growing.truncate(attachment_limit + 1)\n            data = file.read(attachment_limit + 1)',
          ),
        });
      },
    } as unknown as OpenSshPool;
    await expect(readRemoteFile(growingPool, target, file("growing.png", png), defaults)).rejects.toThrow("Attachment exceeds 10 MiB limit");
  });
});

describe("remote read failures", () => {
  for (const phase of ["prefix scan", "directory iteration"] as const) {
    test(`remote alarm bounds a blocked ${phase} without the local process timeout`, async () => {
      const path = file("deadline.txt", "unchanged\nsecond\n");
      let response: RunResult | undefined;
      const boundedPool = {
        async run(target: ParsedSsh, command: string, options: RunOptions) {
          const script = String(options.input);
          expect(script).toContain("signal.alarm(30)");
          // Shorten the real remote alarm only once this phase has been reached.
          // signal.pause blocks in the OS; no polling loop cooperates with it.
          const marker = phase === "prefix scan" ? "part = read(65536, line=True)" : "directory = item.is_dir()";
          const indent = phase === "prefix scan" ? "                " : "                    ";
          const blocked = `print(${JSON.stringify(phase)}, flush=True)\n${indent}signal.setitimer(signal.ITIMER_REAL, 0.05)\n${indent}signal.pause()\n${indent}${marker}`;
          response = await pool.run(target, command, { ...options, input: script.replace(marker, blocked) });
          return response;
        },
      } as unknown as OpenSshPool;
      await expect(readRemoteFile(boundedPool, target, phase === "prefix scan" ? path : directory, {
        ...defaults, offset: phase === "prefix scan" ? 2 : 1,
      })).rejects.toThrow("Remote read timed out:");
      expect(response).toMatchObject({ exitCode: 124, timedOut: false, output: `${phase}\n` });
      expect(readFileSync(path, "utf8")).toBe("unchanged\nsecond\n");
    });
  }

  for (const [signal, exitCode] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]] as const) {
    test(`remote ${signal} terminates without emitting a successful read`, async () => {
      const path = file("terminated.txt", "unchanged");
      let response: RunResult | undefined;
      const signalledPool = {
        async run(target: ParsedSsh, command: string, options: RunOptions) {
          response = await pool.run(target, command, {
            ...options,
            input: String(options.input).replace("info = os.stat(path)", `os.kill(os.getpid(), signal.${signal})\n    info = os.stat(path)`),
          });
          return response;
        },
      } as unknown as OpenSshPool;
      await expect(readRemoteFile(signalledPool, target, path, defaults)).rejects.toThrow(`Remote read terminated (exit ${exitCode})`);
      expect(response).toMatchObject({ exitCode, timedOut: false, output: "" });
      expect(readFileSync(path, "utf8")).toBe("unchanged");
    });
  }

  test("rejects a file swapped to a FIFO between stat and open without blocking", async () => {
    const path = file("swapped.txt", "fixture");
    const swappedPool = {
      run(target: ParsedSsh, command: string, options: RunOptions) {
        return pool.run(target, command, {
          ...options,
          input: String(options.input).replace(
            'with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK), "rb") as file:',
            'os.unlink(path)\n    os.mkfifo(path)\n    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK), "rb") as file:',
          ),
        });
      },
    } as unknown as OpenSshPool;
    await expect(readRemoteFile(swappedPool, target, path, defaults)).rejects.toThrow("Cannot read non-regular file:");
  });

  test("distinguishes missing files from binary rejection", async () => {
    await expect(read(join(directory, "missing"))).rejects.toThrow("File not found:");
    for (const [name, content] of [
      ["null.txt", Buffer.from("a\0b")], ["module.wasm", Buffer.from("text")],
      ["control.txt", Buffer.from([1, 2, 3, 65])],
    ] as const) {
      await expect(read(file(name, content))).rejects.toThrow("Cannot read binary file:");
    }
  });

  test("surfaces actual Python read errors instead of returning successful empty content", async () => {
    const errorPool = {
      run(target: ParsedSsh, command: string, options: RunOptions) {
        return pool.run(target, command, {
          ...options,
          input: String(options.input).replace("data = file.readline(size) if line else file.read(size)", 'raise OSError("injected disk read failure")'),
        });
      },
    } as unknown as OpenSshPool;
    await expect(readRemoteFile(errorPool, target, file("error.txt", "hello"), defaults)).rejects.toThrow("injected disk read failure");
  });

  test("rejects invalid parameters before execution", async () => {
    for (const options of [{ offset: -1 }, { offset: 1.5 }, { limit: -1 }, { maxBytes: 0 }, { maxBytes: NaN }]) {
      await expect(read("unused", options)).rejects.toThrow("safe integer");
    }
    expect(calls).toHaveLength(0);
  });

  test("propagates pre-abort and cleans internal output when abort races with the returned result", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled read"));
    await expect(readRemoteFile(pool, target, "unused", { ...defaults, signal: controller.signal })).rejects.toThrow("cancelled read");
    expect(calls).toHaveLength(0);
    const active = new AbortController();
    const reason = new Error("cancelled in flight");
    const artifactPath = file("aborted-output.log", "internal protocol output");
    const abortPool = {
      async run() {
        active.abort(reason);
        return { output: "{}", exitCode: 0, timedOut: false, truncated: true, artifactPath };
      },
    } as unknown as OpenSshPool;
    await expect(readRemoteFile(abortPool, target, "unused", { ...defaults, signal: active.signal })).rejects.toBe(reason);
    expect(existsSync(artifactPath)).toBe(false);
  });

  test("forwards cancellation to a running Python process", async () => {
    const controller = new AbortController();
    const waitingPool = {
      run(target: ParsedSsh, command: string, options: RunOptions) {
        return pool.run(target, command, { ...options, input: "import time; time.sleep(10)\n" + String(options.input) });
      },
    } as unknown as OpenSshPool;
    const pending = readRemoteFile(waitingPool, target, file("abort.txt", "hello"), { ...defaults, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      await expect(pending).rejects.toThrow("aborted");
      expect(calls[0]?.signal).toBe(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  });

  test("rejects timeout, exit failure, corrupt JSON, and truncation while deleting internal output", async () => {
    for (const [response, message] of [
      [{ timedOut: true }, "timed out"],
      [{ exitCode: 124 }, "timed out"],
      [{ exitCode: 255, output: "SSH disconnected" }, "SSH disconnected"],
      [{ exitCode: 127, output: "python3: command not found" }, "python3: command not found"],
      [{ output: "not json" }, "Remote read failed"],
      [{ output: "null" }, "Invalid remote read response"],
      [{ truncated: true, output: '{"kind":"file"}' }, "transport output was truncated"],
    ] as const) {
      const artifactPath = file("failed-output.log", "internal protocol output");
      const failed = {
        async run() { return Object.assign({ output: "{}", exitCode: 0, timedOut: false, truncated: false, artifactPath }, response); },
      } as unknown as OpenSshPool;
      await expect(readRemoteFile(failed, target, "unused", defaults)).rejects.toThrow(message);
      expect(existsSync(artifactPath)).toBe(false);
    }
    const failure = new Error("transport rejected");
    const rejecting = { async run() { throw failure; } } as unknown as OpenSshPool;
    await expect(readRemoteFile(rejecting, target, "unused", defaults)).rejects.toBe(failure);
  });

  test("best-effort artifact cleanup does not mask the original read error", async () => {
    const artifactPath = join(directory, "not-a-file");
    mkdirSync(artifactPath); // unlinkSync must fail rather than recursively delete a directory.
    const failed = {
      async run() { return { output: "{}", exitCode: 0, timedOut: false, truncated: true, artifactPath }; },
    } as unknown as OpenSshPool;
    await expect(readRemoteFile(failed, target, "unused", defaults)).rejects.toThrow("transport output was truncated");
    expect(existsSync(artifactPath)).toBe(true);
  });
});

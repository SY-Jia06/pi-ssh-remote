import { unlinkSync } from "node:fs";
import { quote, type OpenSshPool, type ParsedSsh } from "./core.js";

/**
 * Remote adaptation of OpenCode v1.18.30 read.ts and util/media.ts:
 * https://github.com/anomalyco/opencode/tree/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src
 * Copyright (c) 2025 opencode; MIT license in vendor/LICENSE.opencode.
 *
 * Deliberate differences from the host tool:
 * - Caller supplies bounds (adapter defaults: 400 lines / 16 KiB). maxBytes caps
 *   both selected source bytes and displayed text, excluding wrappers/numbers.
 *   A 4096-byte MIME/binary sample, per-line one-byte lookahead, and Python's bounded
 *   buffer are additional I/O. Seeking to offset scans only the necessary prefix
 *   in 64-KiB chunks; it cannot avoid that cost without a remote line index.
 * - Stop at the line/source/display cap, never scan the tail to count lines.
 *   totalLines is null unless EOF was observed. If stopped within a line,
 *   incompleteLine/nextOffset identify that same line, with explicit guidance
 *   to increase configured readMaxBytes, inspect a byte range, or skip it.
 *   Transport tail truncation is always an error.
 * - A remote 30-second SIGALRM deadline covers prefix scans, directory iteration,
 *   file reads, and response encoding/output independently of the SSH client.
 *   SIGHUP/SIGINT/SIGTERM terminate immediately when delivered; the alarm remains
 *   the fallback when a dropped SSH channel does not deliver a termination signal.
 * - Long lines retain at most 2000 UTF-16 units, avoiding a split surrogate pair.
 *   Invalid UTF-8 uses replacement characters; an incomplete scalar at a byte
 *   boundary is withheld. LF/CRLF are line endings; bare CR is preserved.
 * - Directories use Unicode code-point sorting (not host localeCompare), list
 *   directory symlinks with '/', and apply the byte cap to whole entries.
 * - MIME signatures match upstream; extension fallback uses Python mimetypes.
 *   Supported attachments are PNG/JPEG/GIF/WebP/PDF, capped at 10 MiB before
 *   base64 transfer (including growth after stat). Other binary files are rejected
 *   using upstream's extensions and 4096-byte control-byte heuristic.
 * - Regular files/directories only; no FIFO/device reads, typo suggestions,
 *   instruction discovery, LSP warm-up, permissions, or local path resolution.
 */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// Sent on stdin to a fresh python3 process. No remote helper or third-party module.
const READ_SCRIPT = String.raw`
import os, signal

def terminate(signum, _frame):
    # Read-only process: exit without buffered output, interpreter cleanup, or an
    # exception that an OSError handler could swallow. The OS closes descriptors.
    os._exit(124 if signum == signal.SIGALRM else 128 + signum)

for signum in (signal.SIGALRM, signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(signum, terminate)
signal.alarm(30)

import base64, codecs, json, mimetypes, stat, sys

path = sys.argv[1]
opts = json.loads(sys.argv[2])
offset, limit, max_bytes = opts["offset"], opts["limit"], opts["maxBytes"]
attachment_limit = 10 * 1024 * 1024
binary_extensions = set(".zip .tar .gz .exe .dll .so .class .jar .war .7z .doc .docx .xls .xlsx .ppt .pptx .odt .ods .odp .bin .dat .obj .o .a .lib .wasm .pyc .pyo".split())

def attachment_mime(sample):
    for signature, mime in [
        (b"\x89PNG\r\n\x1a\n", "image/png"),
        (b"\xff\xd8\xff", "image/jpeg"),
        (b"GIF8", "image/gif"),
        (b"BM", "image/bmp"),
        (b"%PDF-", "application/pdf"),
    ]:
        if sample.startswith(signature):
            return mime
    if sample.startswith(b"RIFF") and sample[8:12] == b"WEBP":
        return "image/webp"
    return mimetypes.guess_type(path)[0] or "application/octet-stream"

def run():
    info = os.stat(path)
    if stat.S_ISDIR(info.st_mode):
        with os.scandir(path) as items:
            entries = []
            for item in items:
                try:
                    directory = item.is_dir()
                except OSError:
                    directory = False
                entries.append(item.name + ("/" if directory else ""))
        entries.sort()
        selected, size = [], 0
        cut = False
        for entry in entries[offset - 1:offset - 1 + limit]:
            entry_size = len(entry.encode("utf-8", "replace")) + bool(selected)
            if size + entry_size > max_bytes:
                if not selected:
                    raise ValueError("Directory entry exceeds configured readMaxBytes budget; increase readMaxBytes to read it")
                cut = True
                break
            selected.append(entry)
            size += entry_size
        return dict(kind="directory", entries=selected, totalEntries=len(entries), cut=cut)

    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Cannot read non-regular file: " + path)

    # O_NONBLOCK prevents a path swapped to a FIFO after stat from blocking open.
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK), "rb") as file:
        # Check the opened descriptor as well as the path's initial stat.
        current = os.fstat(file.fileno())
        if not stat.S_ISREG(current.st_mode):
            raise ValueError("Cannot read non-regular file: " + path)
        sample = file.read(4096)
        bytes_read = len(sample)
        mime = attachment_mime(sample)
        if mime in {"image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"}:
            if current.st_size > attachment_limit:
                raise ValueError("Attachment exceeds 10 MiB limit: " + path)
            file.seek(0)
            data = file.read(attachment_limit + 1)
            if len(data) > attachment_limit:
                raise ValueError("Attachment exceeds 10 MiB limit: " + path)
            return dict(kind="attachment", mime=mime, data=base64.b64encode(data).decode("ascii"))

        nonprintable = sum(byte < 9 or 13 < byte < 32 for byte in sample)
        if os.path.splitext(path)[1].lower() in binary_extensions or b"\0" in sample or (sample and nonprintable / len(sample) > 0.3):
            raise ValueError("Cannot read binary file: " + path)

        file.seek(0)
        def read(size, line=False):
            nonlocal bytes_read
            data = file.readline(size) if line else file.read(size)
            bytes_read += len(data)
            return data

        def has_more():
            data = read(1)
            if data:
                file.seek(-1, os.SEEK_CUR)
            return bool(data)

        # Skip only the prefix required by the caller; never allocate a whole line.
        count = 0
        while count < offset - 1:
            seen = False
            while True:
                part = read(65536, line=True)
                if not part:
                    break
                seen = True
                if part.endswith(b"\n"):
                    break
            if not seen:
                break
            count += 1

        more = has_more()
        if not more and not (count == 0 and offset == 1):
            raise ValueError("Offset %d is out of range for this file (%d lines)" % (offset, count))

        lines, long_lines = [], []
        scanned, displayed = 0, 0
        cut, incomplete = False, None
        while more and len(lines) < limit and scanned < max_bytes:
            available = max_bytes - scanned
            data = read(available + 1, line=True)
            partial = len(data) > available
            scanned += min(len(data), available)
            data = data[:available]
            number = count + 1
            if partial:
                cut = True
                if lines:
                    # Resume at this real line rather than display a cut tail fragment.
                    break
                incomplete = number
            else:
                count += 1
                if data.endswith(b"\n"):
                    data = data[:-1]
                    if data.endswith(b"\r"):
                        data = data[:-1]

            decoder = codecs.getincrementaldecoder("utf-8-sig" if number == 1 else "utf-8")("replace")
            text = decoder.decode(data, final=not partial)
            units = text.encode("utf-16-le")
            if len(units) > 4000:
                text = units[:4000].decode("utf-16-le", "ignore") + "... (line truncated to 2000 chars)"
                long_lines.append(number)
            encoded = text.encode("utf-8")
            room = max_bytes - displayed - bool(lines)
            if len(encoded) > room:
                cut = True
                if lines:
                    # Keep complete displayed lines and resume at the omitted line.
                    incomplete = None
                    break
                text = encoded[:max(0, room)].decode("utf-8", "ignore")
                incomplete = number
            lines.append(text)
            displayed += len(text.encode("utf-8")) + (len(lines) > 1)
            if incomplete is not None:
                more = True
                break
            more = has_more()
            if displayed >= max_bytes:
                break

        if more and (scanned >= max_bytes or displayed >= max_bytes):
            cut = True
        return dict(kind="file", lines=lines, more=more, cut=cut,
                    incompleteLine=incomplete, longLinesTruncated=long_lines,
                    totalLines=None if more else count, bytesRead=bytes_read,
                    sourceBytes=current.st_size)

try:
    result = run()
except FileNotFoundError:
    result = dict(error="File not found: " + path)
except (OSError, ValueError) as error:
    result = dict(error=str(error))
print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
sys.exit(1 if "error" in result else 0)
`;

type ReadPayload =
  | { kind: "directory"; entries: string[]; totalEntries: number; cut: boolean }
  | { kind: "attachment"; mime: string; data: string }
  | {
      kind: "file";
      lines: string[];
      more: boolean;
      cut: boolean;
      incompleteLine: number | null;
      longLinesTruncated: number[];
      totalLines: number | null;
      bytesRead: number;
      sourceBytes: number;
    };

export async function readRemoteFile(
  pool: OpenSshPool,
  target: ParsedSsh,
  path: string,
  options: { offset: number; limit: number; maxBytes: number; signal?: AbortSignal },
): Promise<{
  output: string;
  metadata: Record<string, unknown>;
  attachments?: Array<{ type: "file"; mime: string; url: string; filename?: string }>;
}> {
  options.signal?.throwIfAborted();
  for (const key of ["offset", "limit", "maxBytes"] as const) {
    if (!Number.isSafeInteger(options[key]) || options[key] < (key === "maxBytes" ? 1 : 0)) {
      throw new Error(`${key} must be ${key === "maxBytes" ? "a positive" : "a non-negative"} safe integer`);
    }
  }
  const offset = options.offset || 1;
  const args = { offset, limit: options.limit, maxBytes: options.maxBytes };
  const result = await pool.run(target, `python3 - ${quote(path)} ${quote(JSON.stringify(args))}`, {
    input: READ_SCRIPT,
    signal: options.signal,
    timeoutMs: 30_000,
    useRemoteTimeout: false,
    // ASCII JSON is a single line. Leave space for escaping and a full attachment;
    // never let the pool's tail retention turn the end of a file into its beginning.
    maxLines: 2,
    maxBytes: Math.max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4, options.maxBytes * 6) + 64 * 1024,
  });
  try {
    options.signal?.throwIfAborted();
    if (result.timedOut || result.exitCode === 124) throw new Error(`Remote read timed out: ${path}`);
    if ([129, 130, 143].includes(result.exitCode)) throw new Error(`Remote read terminated (exit ${result.exitCode}): ${path}`);
    if (result.truncated) throw new Error(`Remote read transport output was truncated: ${path}`);
    let payload: ReadPayload & { error?: string };
    try {
      payload = JSON.parse(result.output);
    } catch {
      throw new Error(`Remote read failed (${result.exitCode}): ${result.output.trim() || "empty response"}`);
    }
    if (result.exitCode !== 0 || payload?.error) {
      throw new Error(payload?.error || `Remote read failed (exit ${result.exitCode}): ${path}`);
    }
    if (!payload || !["file", "directory", "attachment"].includes(payload.kind)) {
      throw new Error(`Invalid remote read response: ${path}`);
    }

    if (payload.kind === "attachment") {
      const msg = payload.mime === "application/pdf" ? "PDF read successfully" : "Image read successfully";
      return {
        output: msg,
        metadata: { preview: msg, truncated: false, loaded: [] },
        attachments: [{ type: "file", mime: payload.mime, url: `data:${payload.mime};base64,${payload.data}` }],
      };
    }
    if (payload.kind === "directory") {
      const truncated = offset - 1 + payload.entries.length < payload.totalEntries;
      const nextOffset = offset + payload.entries.length;
      return {
        output: [
          `<path>${path}</path>`, "<type>directory</type>", "<entries>", payload.entries.join("\n"),
          truncated
            ? `\n(Showing ${payload.entries.length} of ${payload.totalEntries} entries.${payload.cut ? ` Output capped at ${options.maxBytes} bytes.` : ""} Use offset=${nextOffset} to continue.)`
            : `\n(${payload.totalEntries} entries)`,
          "</entries>",
        ].join("\n"),
        metadata: {
          preview: payload.entries.slice(0, 20).join("\n"), truncated, loaded: [],
          ...(truncated ? { nextOffset } : {}),
          display: { type: "directory", path, entries: payload.entries, offset, totalEntries: payload.totalEntries, truncated },
        },
      };
    }

    const last = offset + payload.lines.length - 1;
    const truncated = payload.more || payload.cut;
    const nextOffset = payload.incompleteLine ?? last + 1;
    let footer: string;
    if (payload.incompleteLine !== null) {
      footer = `(Output capped at ${options.maxBytes} bytes; line ${payload.incompleteLine} is incomplete. Increase the configured readMaxBytes budget and re-read with offset=${nextOffset}, or inspect a focused byte range via remote_bash. Use offset=${nextOffset + 1} to skip this line's remaining text if another line exists; locating it still scans the prefix and is subject to the read timeout. Total line count unknown.)`;
    } else if (truncated) {
      const showing = payload.lines.length ? `Showing lines ${offset}-${last}` : "No lines shown";
      footer = `(${payload.cut ? `Output capped at ${options.maxBytes} bytes. ` : ""}${showing}. Total line count unknown. Use offset=${nextOffset} to continue${options.limit === 0 ? " with a positive limit" : ""}.)`;
    } else {
      footer = `(End of file - total ${payload.totalLines} lines)`;
    }
    return {
      output: [
        `<path>${path}</path>`, "<type>file</type>", "<content>",
        payload.lines.map((line, i) => `${offset + i}: ${line}`).join("\n"), "", footer, "</content>",
      ].join("\n"),
      metadata: {
        preview: payload.lines.slice(0, 20).join("\n"), truncated, loaded: [],
        ...(truncated ? { nextOffset } : {}),
        incompleteLine: payload.incompleteLine,
        longLinesTruncated: payload.longLinesTruncated,
        bytesRead: payload.bytesRead,
        sourceBytes: payload.sourceBytes,
        display: {
          type: "file", path, text: payload.lines.join("\n"), lineStart: offset,
          lineEnd: last, totalLines: payload.totalLines, truncated,
        },
      },
    };
  } finally {
    // Internal protocol output has no registered artifactRef and must not linger.
    if (result.artifactPath) {
      try { unlinkSync(result.artifactPath); } catch { /* Preserve the read result or original error. */ }
    }
  }
}

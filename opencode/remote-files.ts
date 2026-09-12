import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { quote, type OpenSshPool, type ParsedSsh } from "./core.js";

export interface FileSnapshot {
  path: string;
  content: string;
  version: string | null;
  exists: boolean;
  /** Binds a missing-file snapshot to its resolved destination and symlink entry. */
  identity?: string;
}

export interface FileChange {
  path: string;
  version: string | null;
  content: string | null;
  /** Preserve a snapshot's identity when present; direct creates may omit it. */
  identity?: string;
}

const MAX_TEXT_BYTES = 10 * 1024 * 1024;

// Keep the program in the command, and the length/digest-checked request on stdin:
// an interrupted upload must never turn into a successful, partial file write.
const PROGRAM = String.raw`
import fcntl
import hashlib
import json
import os
import re
import signal
import stat
import sys
import tempfile

LIMIT = 10 * 1024 * 1024

def interrupted(signum, frame):
    if signum == signal.SIGALRM:
        raise TimeoutError("Remote file operation timed out")
    raise InterruptedError("Remote file operation interrupted")

for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM, signal.SIGALRM):
    signal.signal(sig, interrupted)
signal.alarm(30)

def signature(st):
    return (st.st_dev, st.st_ino, st.st_mode, st.st_nlink, st.st_uid,
            st.st_gid, st.st_size, st.st_mtime_ns, st.st_ctime_ns)

def text(data, path):
    if len(data) > LIMIT:
        raise ValueError("Text file exceeds 10 MiB limit: " + path)
    if re.search(br"[\x00-\x08\x0b\x0e-\x1f\x7f]", data):
        raise ValueError("Binary file is not supported: " + path)
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("File is not valid UTF-8 text: " + path)

def inspect(path):
    if not isinstance(path, str) or not path or "\x00" in path:
        raise ValueError("File path must be a nonempty string without NUL")
    if path.endswith("/"):
        raise ValueError("File path must not end with a directory separator: " + path)
    resolved = os.path.realpath(path)
    try:
        entry = os.lstat(path)
    except FileNotFoundError:
        entry = None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    except FileNotFoundError:
        # realpath can collapse missing/../file although the original path cannot
        # be opened. Never treat an existing canonical write target as absent.
        if os.path.lexists(resolved):
            raise ValueError("File path cannot be resolved safely: " + path)
        state = json.dumps([resolved, signature(entry) if entry is not None else None]).encode("utf-8")
        identity = hashlib.sha256(state).hexdigest()
        return {"path": path, "content": "", "version": None, "exists": False,
                "identity": identity}, resolved, None, entry
    with os.fdopen(fd, "rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("Not a regular text file: " + path)
        if before.st_size > LIMIT:
            raise ValueError("Text file exceeds 10 MiB limit: " + path)
        data = source.read(LIMIT + 1)
        after = os.fstat(source.fileno())
    if (entry is None or signature(before) != signature(after)
            or signature(after) != signature(os.stat(path))
            or signature(entry) != signature(os.lstat(path))
            or resolved != os.path.realpath(path)):
        raise ValueError("File changed while reading: " + path)
    content = text(data, path)
    state = json.dumps([resolved, signature(after), signature(entry)]).encode("utf-8")
    version = hashlib.sha256(state + b"\x00" + data).hexdigest()
    return {"path": path, "content": content, "version": version, "exists": True}, resolved, after, entry

def validate(item):
    snapshot, resolved, st, entry = inspect(item["path"])
    entry_state = signature(entry) if entry is not None else None
    if (snapshot["version"] != item["version"] or resolved != item["resolved"]
            or entry_state != item["entry"]
            or (item["identity"] is not None and snapshot.get("identity") != item["identity"])):
        raise ValueError("Stale file snapshot: " + item["path"])

def commit(changes):
    prepared = []
    paths = set()
    inodes = set()
    for change in changes:
        path, version, content = change["path"], change["version"], change["content"]
        identity = change.get("identity")
        if version is not None and not isinstance(version, str):
            raise ValueError("Invalid file version")
        if "identity" in change and not isinstance(identity, str):
            raise ValueError("Invalid file identity")
        data = None
        if content is not None:
            if not isinstance(content, str):
                raise ValueError("File content must be text or null")
            try:
                data = content.encode("utf-8")
            except UnicodeEncodeError:
                raise ValueError("File content is not valid UTF-8 text: " + path)
            text(data, path)
        snapshot, resolved, st, entry = inspect(path)
        if (snapshot["version"] != version
                or (identity is not None and snapshot.get("identity") != identity)):
            raise ValueError("Stale file snapshot: " + path)
        inode = (st.st_dev, st.st_ino) if st is not None else None
        if resolved in paths or (inode is not None and inode in inodes):
            raise ValueError("Duplicate or aliased file change: " + path)
        paths.add(resolved)
        if inode is not None:
            inodes.add(inode)
        prepared.append({"path": path, "version": version, "identity": identity, "resolved": resolved,
                         "entry": signature(entry) if entry is not None else None,
                         "data": data, "mode": stat.S_IMODE(st.st_mode) if st else None})

    # A file and one of its descendants cannot both be mutation targets.
    for path in paths:
        parent = os.path.dirname(path)
        while parent != os.path.dirname(parent):
            if parent in paths:
                raise ValueError("Overlapping file changes: " + path)
            parent = os.path.dirname(parent)

    staged = []
    try:
        for item in prepared:
            if item["data"] is None:
                staged.append(None)
                continue
            parent = os.path.dirname(item["resolved"])
            os.makedirs(parent, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=".opencode-ssh-remote-", dir=parent)
            staged.append(temporary)
            with os.fdopen(fd, "wb") as output:
                output.write(item["data"])
                output.flush()
                mode = item["mode"]
                if mode is None:
                    mask = os.umask(0)
                    os.umask(mask)
                    mode = 0o666 & ~mask
                os.fchmod(output.fileno(), mode)
                os.fsync(output.fileno())

        # Validate the entire batch before the first replacement, including after
        # staging. The lock excludes other invocations of this backend throughout.
        for item in prepared:
            validate(item)
        # Native moves write their destination before unlinking their source.
        # Finish every write before any deletion, regardless of plan order.
        for item, temporary in zip(prepared, staged):
            if temporary is not None:
                validate(item)
                # Follow file symlinks for writes; do not replace the symlink.
                os.replace(temporary, item["resolved"])
        for item in prepared:
            if item["data"] is None:
                validate(item)
                if item["entry"] is not None:
                    # Like native unlink, deletion removes the requested directory entry.
                    os.unlink(item["path"])
    finally:
        for temporary in staged:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass

def main():
    length = int(sys.argv[1])
    raw = sys.stdin.buffer.read(length + 1)
    if len(raw) != length or hashlib.sha256(raw).hexdigest() != sys.argv[2]:
        raise ValueError("Incomplete or corrupted remote file request")
    request = json.loads(raw)
    operation = request["operation"]
    if operation not in ("snapshot", "commit"):
        raise ValueError("Unknown remote file operation")

    # One persistent, per-UID lock in the runtime temp directory avoids alias and
    # deadlock bookkeeping. Cooperating invocations must share this directory.
    # Never unlink it: waiters must always lock the same inode. This is advisory;
    # other users/hosts and unrelated writers do not participate.
    lock_path = os.path.join(tempfile.gettempdir(), "opencode-ssh-remote-files-%s.lock" % os.getuid())
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        st = os.fstat(lock.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_nlink != 1:
            raise ValueError("Unsafe remote file lock: " + lock_path)
        fcntl.lockf(lock.fileno(), fcntl.LOCK_SH if operation == "snapshot" else fcntl.LOCK_EX)
        if operation == "snapshot":
            result = inspect(request["path"])[0]
        else:
            commit(request["changes"])
            result = {"ok": True}
    print(json.dumps(result, ensure_ascii=True))

try:
    main()
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(124 if isinstance(error, TimeoutError) else 1)
`;

/** Text-only filesystem backend. Commits are atomic per file, not per batch. */
export class RemoteFiles {
  constructor(
    private readonly pool: OpenSshPool,
    private readonly target: ParsedSsh,
    private readonly signal?: AbortSignal,
  ) {}

  async snapshot(path: string): Promise<FileSnapshot> {
    const value = await this.request({ operation: "snapshot", path });
    if (!value || value.path !== path || typeof value.content !== "string"
      || typeof value.exists !== "boolean"
      || (value.identity !== undefined && typeof value.identity !== "string")
      || (value.exists ? typeof value.version !== "string" : value.version !== null || value.content !== "")) {
      throw new Error("Invalid remote file snapshot response");
    }
    return {
      path,
      content: value.content,
      exists: value.exists,
      version: typeof value.version === "string" ? value.version : null,
      ...(value.identity !== undefined ? { identity: value.identity } : {}),
    };
  }

  async commit(changes: FileChange[]): Promise<void> {
    this.signal?.throwIfAborted();
    if (!changes.length) return;
    const value = await this.request({ operation: "commit", changes });
    if (value?.ok !== true) throw new Error("Invalid remote file commit response");
  }

  private async request(request: object): Promise<Record<string, unknown>> {
    this.signal?.throwIfAborted();
    const input = JSON.stringify(request);
    const digest = createHash("sha256").update(input).digest("hex");
    const result = await this.pool.run(this.target,
      `python3 -c ${quote(PROGRAM)} ${Buffer.byteLength(input)} ${digest}`, {
        input,
        signal: this.signal,
        timeoutMs: 30_000,
        useRemoteTimeout: false, // Python's alarm also bounds lock waits and stdin reads.
        maxLines: 10,
        // JSON can expand one text byte to six ASCII bytes (e.g. a control escape).
        maxBytes: MAX_TEXT_BYTES * 6 + 64 * 1024,
      }).catch((error: unknown) => {
        this.signal?.throwIfAborted();
        throw error;
      });
    try {
      this.signal?.throwIfAborted();
      if (result.timedOut || result.exitCode === 124) throw new Error("Remote file operation timed out");
      if (result.exitCode !== 0) {
        throw new Error(`Remote file operation failed: ${result.output.trim() || `exit ${result.exitCode}`}`);
      }
      if (result.truncated) throw new Error("Remote file response was truncated");
      try {
        const value = JSON.parse(result.output);
        if (value && typeof value === "object" && !Array.isArray(value)) return value;
      } catch {
        // Include neither the snapshot contents nor a potentially huge malformed response.
      }
      throw new Error("Invalid remote file response");
    } finally {
      if (result.artifactPath) {
        try { unlinkSync(result.artifactPath); } catch { /* Internal transport output: best-effort cleanup. */ }
      }
    }
  }
}

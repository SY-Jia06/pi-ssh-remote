import { Buffer } from "node:buffer";
import type { FileChange, FileSnapshot } from "./remote-files.js";
import * as Patch from "./vendor/opencode-patch.js";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_LINES = 50_000;
const MAX_PATHS = 1_024;

export interface PatchPlan {
  changes: FileChange[];
  files: Array<{ path: string; type: "add" | "update" | "delete" | "move"; movePath?: string }>;
}

function textSize(text: string, label: string): number {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_BYTES) throw new Error(`${label} exceeds the 10 MiB patch edit limit`);
  let lines = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    if (++lines > MAX_LINES) throw new Error(`${label} exceeds the ${MAX_LINES} line patch edit limit`);
  }
  return bytes;
}

/**
 * Prepare the entire patch without writes. Paths must resolve to stable remote
 * identities; snapshots must include original UTF-8 text (including any BOM).
 * Repeated paths use a sequential overlay, retaining each initial version.
 * The caller must verify all returned versions before committing any changes.
 * See vendor/opencode-patch.LICENSE for exact upstream compatibility and limits.
 */
export async function planPatch(
  patchText: string,
  options: {
    resolvePath: (path: string) => string;
    snapshot: (path: string) => Promise<FileSnapshot>;
  },
): Promise<PatchPlan> {
  textSize(patchText, "patchText");
  if (!patchText.trim()) throw new Error("patchText is required");
  let hunks: ReadonlyArray<Patch.Hunk>;
  try {
    hunks = Patch.parse(patchText);
  } catch (error) {
    throw new Error(`apply_patch verification failed: ${String(error)}`, { cause: error });
  }
  if (hunks.length === 0) throw new Error("patch rejected: empty patch");

  const paths = new Set<string>();
  const resolve = (input: string): string => {
    const path = options.resolvePath(input);
    if (!path || path.includes("\0")) throw new Error(`Invalid resolved patch path: ${JSON.stringify(path)}`);
    paths.add(path);
    if (paths.size > MAX_PATHS) throw new Error(`Patch exceeds the ${MAX_PATHS} path edit limit`);
    return path;
  };
  // Resolve all paths before asking for any content, including move destinations.
  const resolved = hunks.map((hunk) => {
    const path = resolve(hunk.path);
    const movePath = hunk.type === "update" && hunk.movePath !== undefined ? resolve(hunk.movePath) : undefined;
    if (movePath === path) throw new Error(`Ambiguous move: source and destination resolve to the same path: ${path}`);
    return { hunk, path, movePath };
  });
  for (const path of paths) {
    for (let slash = path.lastIndexOf("/"); slash > 0; slash = path.lastIndexOf("/", slash - 1)) {
      const parent = path.slice(0, slash);
      if (paths.has(parent)) throw new Error(`Conflicting patch paths: ${parent} is an ancestor of ${path}`);
    }
  }

  const overlay = new Map<string, { version: string | null; identity?: string; content: string | null; bytes: number }>();
  let snapshotBytes = 0;
  let overlayBytes = 0;
  const load = async (path: string) => {
    const cached = overlay.get(path);
    if (cached) return cached;
    const initial = await options.snapshot(path);
    if (initial.path !== path || initial.exists !== (initial.version !== null)) {
      throw new Error(`Inconsistent patch snapshot for ${path}`);
    }
    const bytes = textSize(initial.content, `Snapshot ${path}`);
    snapshotBytes += bytes;
    if (snapshotBytes > MAX_BYTES) throw new Error("Patch snapshots exceed the 10 MiB patch edit limit");
    const entry = {
      version: initial.version,
      ...(initial.identity !== undefined ? { identity: initial.identity } : {}),
      content: initial.exists ? initial.content : null,
      bytes: initial.exists ? bytes : 0,
    };
    overlayBytes += entry.bytes;
    if (overlayBytes > MAX_BYTES) throw new Error("Patch overlay exceeds the 10 MiB patch edit limit");
    overlay.set(path, entry);
    return entry;
  };
  const set = (path: string, content: string | null) => {
    const entry = overlay.get(path)!;
    const bytes = content === null ? 0 : textSize(content, `Patched file ${path}`);
    overlayBytes += bytes - entry.bytes;
    if (overlayBytes > MAX_BYTES) throw new Error("Patch overlay exceeds the 10 MiB patch edit limit");
    entry.content = content;
    entry.bytes = bytes;
  };

  const files: PatchPlan["files"] = [];
  for (const { hunk, path, movePath } of resolved) {
    const source = await load(path);
    if (hunk.type === "add") {
      // Native apply_patch adds a final LF to nonempty content, and overwrites.
      set(path, hunk.contents === "" || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`);
      files.push({ path, type: "add" });
      continue;
    }
    if (source.content === null) {
      throw new Error(`apply_patch verification failed: Failed to read file to ${hunk.type}: ${path}`);
    }
    if (hunk.type === "delete") {
      set(path, null);
      files.push({ path, type: "delete" });
      continue;
    }
    let updated: Patch.FileUpdate;
    try {
      updated = Patch.derive(path, hunk.chunks, source.content);
    } catch (error) {
      throw new Error(`apply_patch verification failed: ${String(error)}`, { cause: error });
    }
    const content = Patch.joinBom(updated.content, updated.bom);
    if (movePath !== undefined) {
      await load(movePath);
      set(path, null);
      set(movePath, content);
      files.push({ path, type: "move", movePath });
    } else {
      set(path, content);
      files.push({ path, type: "update" });
    }
  }

  const changes: FileChange[] = [];
  for (const [path, { version, identity, content }] of overlay) {
    if (version === null && content === null) continue;
    changes.push({ path, version, ...(identity !== undefined ? { identity } : {}), content });
  }
  return { changes, files };
}

import { replace } from "./vendor/opencode-edit.js";

/**
 * The existing-file branch of OpenCode 1.18.30's edit tool, before formatting.
 * Source: anomalyco/opencode@3104c1428ec91f809e5ab86631300de41eb6952e,
 * packages/opencode/src/tool/edit.ts and src/util/bom.ts (MIT; vendor/LICENSE.opencode).
 *
 * Content represents an existing file, including an existing empty file. Thus an
 * empty oldString is rejected: the caller must separately implement the official
 * missing-file creation branch. No trailing newline is added. CRLF anywhere in
 * the source selects CRLF for old/new strings; source mixed endings stay mixed.
 * BOM split/join and both pre- and post-normalization no-op checks follow upstream.
 * This pure function cannot run formatters, LSP, locks, permissions, or write files.
 */
export function editContent(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.");
  }
  const source = splitBom(content);
  const ending = source.text.includes("\r\n") ? "\r\n" : "\n";
  const normalize = (text: string) => text.replaceAll("\r\n", "\n").replaceAll("\n", ending);
  const next = splitBom(replace(source.text, normalize(oldString), normalize(newString), replaceAll));
  // Upstream Bom.join strips one additional leading BOM before restoring the desired one.
  return (source.bom || next.bom ? "\uFEFF" : "") + splitBom(next.text).text;
}

function splitBom(text: string): { bom: boolean; text: string } {
  if (text.charCodeAt(0) !== 0xfeff) return { bom: false, text };
  return { bom: true, text: text.slice(1) };
}

/** Native missing-file creation branch: BOM split/join, without newline conversion. */
export function newFileContent(content: string): string {
  const next = splitBom(content);
  return (next.bom ? "\uFEFF" : "") + splitBom(next.text).text;
}

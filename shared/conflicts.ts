import type { SkillFile } from "./types.ts";

export interface FileComparison {
  path: string;
  status: "added" | "removed" | "modified" | "permissions";
  local?: SkillFile;
  equip?: SkillFile;
  contentChanged: boolean;
  modeChanged: boolean;
  localText?: string;
  equipText?: string;
  binary: boolean;
}

function bytes(file: SkillFile): Uint8Array {
  return file.encoding === "base64"
    ? Uint8Array.from(atob(file.content), character => character.charCodeAt(0))
    : new TextEncoder().encode(file.content);
}

function text(content: Uint8Array | undefined) {
  if (!content) return undefined;
  if (content.includes(0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(content); }
  catch { return undefined; }
}

/** Matches the server's revision hash, independent of receipt timestamps. */
export async function reviewedFilesRevision(files: SkillFile[]) {
  const canonical = JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)).map(file => {
    let binary = "";
    for (const byte of bytes(file)) binary += String.fromCharCode(byte);
    return { path: file.path, content: btoa(binary), mode: file.mode ?? 0o644 };
  }));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/** Changes are described from the local copy to Equip's selected version. */
export function compareSkillFiles(local: SkillFile[], equip: SkillFile[], compareExecutable = true): FileComparison[] {
  const left = new Map(local.map(file => [file.path, file]));
  const right = new Map(equip.map(file => [file.path, file]));
  const result: FileComparison[] = [];
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(path), b = right.get(path);
    const aBytes = a ? bytes(a) : undefined, bBytes = b ? bytes(b) : undefined;
    const contentChanged = !aBytes || !bBytes || aBytes.length !== bBytes.length || aBytes.some((value, index) => value !== bBytes[index]);
    const modeChanged = compareExecutable && !!a && !!b && Boolean((a.mode ?? 0o644) & 0o111) !== Boolean((b.mode ?? 0o644) & 0o111);
    if (!contentChanged && !modeChanged) continue;
    const localText = text(aBytes), equipText = text(bBytes);
    result.push({ path, local: a, equip: b, contentChanged, modeChanged,
      status: !a ? "added" : !b ? "removed" : contentChanged ? "modified" : "permissions",
      localText, equipText, binary: (!!a && localText === undefined) || (!!b && equipText === undefined),
    });
  }
  return result;
}

export interface DiffLine { kind: "same" | "add" | "remove"; text: string; localLine?: number; equipLine?: number }

export function diffLines(local: string, equip: string): DiffLine[] {
  const a = local.split("\n"), b = equip.split("\n");
  const result: DiffLine[] = [];
  const same = (i: number, j: number) => result.push({ kind: "same", text: a[i], localLine: i + 1, equipLine: j + 1 });
  const remove = (i: number) => result.push({ kind: "remove", text: a[i], localLine: i + 1 });
  const add = (j: number) => result.push({ kind: "add", text: b[j], equipLine: j + 1 });
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) { same(start, start); start++; }
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const rows = endA - start, columns = endB - start;
  // Large generated references remain inspectable without allocating an
  // unbounded quadratic matrix in the browser.
  if (rows * columns > 400_000) {
    for (let i = start; i < endA; i++) remove(i);
    for (let j = start; j < endB; j++) add(j);
  } else {
    const width = columns + 1;
    const matrix = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--)
      for (let j = columns - 1; j >= 0; j--)
        matrix[i * width + j] = a[start + i] === b[start + j]
          ? 1 + matrix[(i + 1) * width + j + 1]
          : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
    let i = 0, j = 0;
    while (i < rows || j < columns) {
      if (i < rows && j < columns && a[start + i] === b[start + j]) { same(start + i++, start + j++); }
      else if (i < rows && (j === columns || matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])) remove(start + i++);
      else add(start + j++);
    }
  }
  while (endA < a.length && endB < b.length) same(endA++, endB++);
  return result;
}

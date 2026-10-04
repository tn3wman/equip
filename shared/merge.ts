import type { SkillFile } from "./types.ts";
import { diffLines } from "./conflicts.ts";

export const MERGE_MARKERS = ["<<<<<<< LOCAL", "||||||| BASE", "=======", ">>>>>>> EQUIP"] as const;

export interface MergeConflict {
  path: string;
  kind: "text" | "binary" | "delete-change" | "mode";
  base?: SkillFile;
  local?: SkillFile;
  equip?: SkillFile;
  candidate?: SkillFile;
  message: string;
}

export interface FolderMerge {
  hasBase: boolean;
  files: SkillFile[];
  conflicts: MergeConflict[];
}

type Edit = { start: number; end: number; lines: string[] };

function decoded(file: SkillFile | undefined) {
  if (!file || file.encoding === "base64" || file.content.includes("\0")) return undefined;
  return file.content;
}

function bytes(file: SkillFile | undefined) {
  if (!file) return undefined;
  if (file.encoding !== "base64") return new TextEncoder().encode(file.content);
  return Uint8Array.from(atob(file.content), value => value.charCodeAt(0));
}

function sameContent(left: SkillFile | undefined, right: SkillFile | undefined) {
  if (!left || !right) return left === right;
  const a = bytes(left)!, b = bytes(right)!;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

const executable = (file: SkillFile | undefined) => Boolean((file?.mode ?? 0o644) & 0o111);
const mode = (file: SkillFile | undefined, value: boolean) => value
  ? ((file?.mode ?? 0o644) | 0o111)
  : ((file?.mode ?? 0o644) & ~0o111);

function edits(base: string, side: string): Edit[] {
  const result: Edit[] = [];
  let position = 0;
  let current: Edit | undefined;
  const flush = () => { if (current) result.push(current); current = undefined; };
  for (const line of diffLines(base, side)) {
    if (line.kind === "same") { flush(); position++; continue; }
    current ??= { start: position, end: position, lines: [] };
    if (line.kind === "remove") { current.end++; position++; }
    else current.lines.push(line.text);
  }
  flush();
  return result;
}

function sameEdit(a: Edit, b: Edit) {
  return a.start === b.start && a.end === b.end &&
    a.lines.length === b.lines.length && a.lines.every((line, index) => line === b.lines[index]);
}

function editsOverlap(a: Edit, b: Edit) {
  if (sameEdit(a, b)) return false;
  const aInsert = a.start === a.end, bInsert = b.start === b.end;
  if (aInsert && bInsert) return a.start === b.start;
  if (aInsert) return b.start <= a.start && a.start < b.end;
  if (bInsert) return a.start <= b.start && b.start < a.end;
  return Math.max(a.start, b.start) < Math.min(a.end, b.end);
}

export function hasMergeMarkers(value: string) {
  return value.split("\n").some(line => /^(<{7}|\|{7}|={7}|>{7})(?:\s|$)/.test(line.trim()));
}

export function mergeText(base: string, local: string, equip: string) {
  if (local === equip) return { content: local, conflicted: false };
  if (local === base) return { content: equip, conflicted: false };
  if (equip === base) return { content: local, conflicted: false };
  const localEdits = edits(base, local), equipEdits = edits(base, equip);
  if (localEdits.some(left => equipEdits.some(right => editsOverlap(left, right))))
    return {
      content: [MERGE_MARKERS[0], local, MERGE_MARKERS[1], base, MERGE_MARKERS[2], equip, MERGE_MARKERS[3]].join("\n"),
      conflicted: true,
    };
  const combined = [...localEdits, ...equipEdits]
    .filter((edit, index, values) => values.findIndex(candidate => sameEdit(candidate, edit)) === index)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const baseLines = base.split("\n"), output: string[] = [];
  let position = 0;
  for (const edit of combined) {
    output.push(...baseLines.slice(position, edit.start), ...edit.lines);
    position = edit.end;
  }
  output.push(...baseLines.slice(position));
  return { content: output.join("\n"), conflicted: false };
}

export function mergeSkillFiles(baseFiles: SkillFile[] | undefined, localFiles: SkillFile[], equipFiles: SkillFile[]): FolderMerge {
  if (!baseFiles) return { hasBase: false, files: [], conflicts: [] };
  const base = new Map(baseFiles.map(file => [file.path, file]));
  const local = new Map(localFiles.map(file => [file.path, file]));
  const equip = new Map(equipFiles.map(file => [file.path, file]));
  const files: SkillFile[] = [], conflicts: MergeConflict[] = [];
  for (const path of [...new Set([...base.keys(), ...local.keys(), ...equip.keys()])].sort()) {
    const ancestor = base.get(path), ours = local.get(path), theirs = equip.get(path);
    if (!ancestor) {
      if (!ours) { if (theirs) files.push(structuredClone(theirs)); continue; }
      if (!theirs) { files.push(structuredClone(ours)); continue; }
      if (!sameContent(ours, theirs) || executable(ours) !== executable(theirs)) {
        if (executable(ours) !== executable(theirs)) {
          conflicts.push({ path, kind: "mode", local: ours, equip: theirs,
            message: "Both versions added this file with different content or executable status." });
          continue;
        }
        const localText = decoded(ours), equipText = decoded(theirs);
        if (localText !== undefined && equipText !== undefined) {
          const candidate = { ...ours, content: [MERGE_MARKERS[0], localText, MERGE_MARKERS[2], equipText, MERGE_MARKERS[3]].join("\n") };
          conflicts.push({ path, kind: "text", local: ours, equip: theirs, candidate, message: "Both versions added this file differently." });
        } else conflicts.push({ path, kind: "binary", local: ours, equip: theirs, message: "Both versions added different binary content." });
      } else files.push(structuredClone(ours));
      continue;
    }
    if (!ours || !theirs) {
      if (!ours && !theirs) continue;
      const present = ours ?? theirs;
      if (sameContent(present, ancestor) && executable(present) === executable(ancestor)) continue;
      conflicts.push({ path, kind: "delete-change", base: ancestor, local: ours, equip: theirs,
        message: `${ours ? "Equip" : "Local"} deleted this file while the other version changed it.` });
      continue;
    }
    const localContentChanged = !sameContent(ours, ancestor);
    const equipContentChanged = !sameContent(theirs, ancestor);
    let chosen = structuredClone(equipContentChanged ? theirs : ours);
    if (localContentChanged && equipContentChanged && !sameContent(ours, theirs)) {
      const baseText = decoded(ancestor), localText = decoded(ours), equipText = decoded(theirs);
      if (baseText === undefined || localText === undefined || equipText === undefined) {
        conflicts.push({ path, kind: "binary", base: ancestor, local: ours, equip: theirs, message: "Both versions changed this binary file." });
        continue;
      }
      const merged = mergeText(baseText, localText, equipText);
      chosen = { ...ours, content: merged.content, encoding: undefined };
      if (merged.conflicted) {
        conflicts.push({ path, kind: "text", base: ancestor, local: ours, equip: theirs, candidate: chosen,
          message: "Both versions changed overlapping lines." });
        continue;
      }
    }
    const baseMode = executable(ancestor), localMode = executable(ours), equipMode = executable(theirs);
    const localModeChanged = localMode !== baseMode, equipModeChanged = equipMode !== baseMode;
    if (localModeChanged && equipModeChanged && localMode !== equipMode) {
      conflicts.push({ path, kind: "mode", base: ancestor, local: ours, equip: theirs, candidate: chosen,
        message: "Both versions changed executable status differently." });
      continue;
    }
    const mergedMode = localModeChanged ? localMode : equipModeChanged ? equipMode : baseMode;
    chosen.mode = mode(chosen, mergedMode);
    files.push(chosen);
  }
  return { hasBase: true, files, conflicts };
}

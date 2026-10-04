import { createHash } from "node:crypto";
import { skillRevision } from "../shared/library.ts";
import type { SkillFile } from "../shared/types.ts";

export function fileHashes(files: SkillFile[]) {
  return Object.fromEntries(files.map(file => [file.path,
    `${file.mode ?? 0o644}:${createHash("sha256").update(Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8")).digest("hex")}`,
  ]));
}

// Keep exact modes in artifacts and legacy ledgers. Only reconciliation ignores
// host-specific read/write bits; changing whether a file can execute still matters.
function comparableHash(hash: string | undefined, platform: NodeJS.Platform) {
  const match = hash?.match(/^(\d+):([a-f0-9]{64})$/);
  if (!match) return hash; // Symlink identities must never match regular files.
  return `${platform !== "win32" && (Number(match[1]) & 0o111) ? "executable" : "file"}:${match[2]}`;
}

export function sameFileHashes(left: Record<string, string>, right: Record<string, string> = {}, platform: NodeJS.Platform = process.platform) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every(key => comparableHash(left[key], platform) === comparableHash(right[key], platform));
}

export function portableFilesRevision(files: SkillFile[]) {
  return skillRevision(files.map(file => ({ ...file,
    mode: process.platform !== "win32" && ((file.mode ?? 0o644) & 0o111) ? 0o755 : 0o644,
  })));
}

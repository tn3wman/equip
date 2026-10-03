import crypto from "node:crypto";
import type { SkillFile } from "./types.ts";

export interface LibrarySnapshotSkill {
  name: string;
  title: string;
  source: string;
  kind: "custom" | "third-party";
  files: SkillFile[];
}

export function canonicalFiles(files: SkillFile[]) {
  return JSON.stringify(
    [...files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({
        path: file.path,
        content: Buffer.from(
          file.content,
          file.encoding === "base64" ? "base64" : "utf8",
        ).toString("base64"),
        mode: file.mode ?? 0o644,
      })),
  );
}

export function skillRevision(files: SkillFile[]) {
  return crypto
    .createHash("sha256")
    .update(canonicalFiles(files))
    .digest("hex")
    .slice(0, 16);
}

export function librarySnapshotRevision(skills: LibrarySnapshotSkill[]) {
  const canonical = JSON.stringify(
    [...skills]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => ({
        name: skill.name,
        title: skill.title,
        source: skill.source,
        kind: skill.kind,
        files: JSON.parse(canonicalFiles(skill.files)),
      })),
  );
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

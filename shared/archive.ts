import { zip, type Zippable } from "fflate";
import type { SkillFile } from "./types.ts";

export function skillArchive(name: string, files: SkillFile[]): Promise<Uint8Array> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error("Invalid archive skill name.");
  const entries: Zippable = {};
  for (const file of [...files].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    if (!file.path || file.path.includes("\\") || file.path.startsWith("/") || file.path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe archive path.");
    entries[`${name}/${file.path}`] = [Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8"), { os: 3, attrs: (0o100000 | (file.mode ?? 0o644)) << 16, mtime: new Date(1980, 0, 2) }];
  }
  return new Promise((resolve,reject) => zip(entries, { level: 6 }, (error,data) => error ? reject(error) : resolve(data)));
}

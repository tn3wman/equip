import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";
import type { DesiredState, SkillFile } from "../shared/types.ts";
import { canonicalFiles, skillRevision } from "../shared/library.ts";
import { collectSkillFiles } from "./library.ts";
import type { AgentTarget } from "./sync.ts";

export type LocalPublication = { name: string; files: SkillFile[]; sourcePath: string; baseRevision?: string; explicit?: boolean };
export type PublishLocal = (skill: LocalPublication) => Promise<{ id: string; revision: string; changed: boolean }>;

export async function localSkill(path: string) {
  const sourcePath = await realpath(path);
  const files = await collectSkillFiles(sourcePath);
  const primary = files.find(f => f.path === "SKILL.md");
  const match = primary?.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const metadata = match ? parse(match[1]) : undefined;
  if (!metadata || typeof metadata.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name) || metadata.name.length > 64 || typeof metadata.description !== "string" || !metadata.description.trim())
    throw new Error("A local skill needs valid name and description in SKILL.md.");
  return { name: metadata.name as string, files, sourcePath };
}

function hashes(files: SkillFile[]) {
  return Object.fromEntries(files.map(f => [f.path, `${f.mode ?? 0o644}:${createHash("sha256").update(Buffer.from(f.content, f.encoding === "base64" ? "base64" : "utf8")).digest("hex")}`]));
}
function sameHashes(a: Record<string,string>, b: Record<string,string>) {
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k]);
}
type Seen = Record<string, { name: string; hash: string; revision: string }>;

/** Only scans explicit skill roots after the owner enables local publishing. */
export async function syncLocalSkills(home: string, targets: AgentTarget[], desired: DesiredState, publish: PublishLocal) {
  if (!desired.localSync || desired.disconnect) return { changed: false, errors: [] as string[] };
  const seenPath = join(home, "local-skills.json");
  const seen: Seen = JSON.parse(await readFile(seenPath, "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; }));
  const ledger = JSON.parse(await readFile(join(home, "ledger.json"), "utf8").catch(error => { if (error.code === "ENOENT") return '{"installs":{}}'; throw error; }));
  const known = new Map((desired.localSkills ?? desired.skills).map(s => [s.name, s]));
  const candidates = new Set<string>();
  const errors: string[] = [];
  for (const root of new Set([join(home, "skills"), ...targets.map(t => t.path)])) {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
      if (entry.name.startsWith(".") || entry.name.includes(".equip-")) continue;
      const path = join(root, entry.name);
      if (!(await stat(join(path, "SKILL.md")).catch(() => null))?.isFile()) continue;
      candidates.add(await realpath(path));
    }
  }
  let changed = false;
  const published = new Map<string,string>();
  for (const path of candidates) {
    try {
      const configured = known.get(basename(path));
      if (configured?.kind === "third-party" || configured?.librarySourceId) continue;
      const local = await localSkill(path);
      const existing = known.get(local.name);
      // Upstream and repository libraries keep their own update authority.
      if (existing?.kind === "third-party" || existing?.librarySourceId) continue;
      const hash = skillRevision(local.files);
      const prior = seen[path];
      if (prior?.hash === hash) continue;
      const desiredSkill = desired.skills.find(s => s.name === local.name);
      if (desiredSkill && canonicalFiles(desiredSkill.files) === canonicalFiles(local.files)) {
        seen[path] = { name: local.name, hash, revision: desiredSkill.revision };
        continue;
      }
      const entries = Object.values(ledger.installs).filter((e: any) => e.skillId === existing?.id) as Array<{ files: Record<string,string>; revision: string }>;
      if (existing && entries.some(e => sameHashes(e.files, hashes(local.files)))) continue;
      if (published.has(local.name)) {
        if (published.get(local.name) !== hash) errors.push(`${local.name}: different local copies need review.`);
        continue;
      }
      const result = await publish({ ...local, baseRevision: existing ? prior?.revision || entries[0]?.revision : prior?.revision });
      seen[path] = { name: local.name, hash, revision: result.revision };
      published.set(local.name, hash);
      changed ||= result.changed;
    } catch (error) { errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  await mkdir(home, { recursive: true });
  const temporary = `${seenPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(seen), { mode: 0o600 });
  await rename(temporary, seenPath);
  return { changed, errors };
}

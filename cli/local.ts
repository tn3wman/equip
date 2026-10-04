import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";
import type { DesiredState, SkillFile } from "../shared/types.ts";
import { skillRevision } from "../shared/library.ts";
import { fileHashes, sameFileHashes, portableFilesRevision } from "./file-state.ts";
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

type Seen = Record<string, { name: string; hash: string; portableHash?: string; revision: string }>;

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
  const inspected = new Map<string, Awaited<ReturnType<typeof localSkill>>>();
  const newCopies = new Map<string, Set<string>>();
  for (const path of candidates) {
    if (known.get(basename(path))?.kind === "third-party") continue;
    try {
      const local = await localSkill(path);
      inspected.set(path, local);
      if (!known.has(local.name)) {
        const copies = newCopies.get(local.name) ?? new Set<string>();
        copies.add(portableFilesRevision(local.files));
        newCopies.set(local.name, copies);
      }
    } catch (error) { errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  // Inspect every unknown copy before publishing any of them. Directory order
  // must not choose the winner when multiple profiles already disagree.
  const ambiguous = new Set([...newCopies].filter(([, copies]) => copies.size > 1).map(([name]) => name));
  for (const name of ambiguous) errors.push(`${name}: different local copies need review.`);
  for (const path of candidates) {
    try {
      const configured = known.get(basename(path));
      if (configured?.kind === "third-party") continue;
      const local = inspected.get(path);
      if (!local || ambiguous.has(local.name)) continue;
      const existing = known.get(local.name);
      if (existing?.kind === "third-party") continue;
      const hash = skillRevision(local.files);
      const portableHash = portableFilesRevision(local.files);
      const prior = seen[path];
      const desiredSkill = desired.skills.find(s => s.name === local.name);
      if (desiredSkill && sameFileHashes(fileHashes(desiredSkill.files), fileHashes(local.files))) {
        seen[path] = { name: local.name, hash, portableHash, revision: desiredSkill.revision };
        continue;
      }
      // A baseline belongs to this physical copy. Another profile's ledger
      // cannot authorize publishing an unrelated preexisting folder.
      const entries: Array<{ files: Record<string,string>; revision: string }> = [];
      for (const entry of Object.values(ledger.installs) as Array<{ skillId: string; path: string; canonicalPath?: string; files: Record<string,string>; revision: string }>) {
        if (entry.skillId !== existing?.id) continue;
        if (entry.canonicalPath === path || await realpath(entry.path).catch(() => undefined) === path)
          entries.push(entry);
      }
      if (existing && entries.some(e => sameFileHashes(e.files, fileHashes(local.files)))) {
        seen[path] = { name: local.name, hash, portableHash, revision: entries.find(e => sameFileHashes(e.files, fileHashes(local.files)))!.revision };
        continue;
      }
      if (prior?.hash === hash || prior?.portableHash === portableHash) continue;
      if (published.has(local.name)) {
        if (published.get(local.name) !== portableHash) errors.push(`${local.name}: different local copies need review.`);
        continue;
      }
      const result = await publish({ ...local, baseRevision: existing ? entries[0]?.revision || prior?.revision : prior?.revision });
      seen[path] = { name: local.name, hash, portableHash, revision: result.revision };
      published.set(local.name, portableHash);
      changed ||= result.changed;
    } catch (error) { errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  await mkdir(home, { recursive: true });
  const temporary = `${seenPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(seen), { mode: 0o600 });
  await rename(temporary, seenPath);
  return { changed, errors };
}

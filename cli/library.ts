import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillFile } from "../shared/types.ts";
import { librarySnapshotRevision, type LibrarySnapshotSkill } from "../shared/library.ts";
import { resolveSkill } from "../shared/upstream.ts";

export interface LibraryLink {
  id: string;
  name: string;
  root: string;
  revision?: string;
  lastSync?: string;
  lastError?: string;
}

function safeName(name: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
    throw new Error(`Invalid Library skill name: ${name}`);
}

export async function collectSkillFiles(root: string, directory = root): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // These generated files are not part of a skill bundle.
    if ([".git", ".DS_Store", "__pycache__"].includes(entry.name) || entry.name.endsWith(".pyc")) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Library skill contains an unsupported link: ${relative(root, path)}`);
    if (entry.isDirectory()) files.push(...await collectSkillFiles(root, path));
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      const binary = !Buffer.from(bytes.toString("utf8")).equals(bytes);
      const mode = (await stat(path)).mode & 0o777;
      files.push({ path: relative(root, path).split("\\").join("/"), content: bytes.toString(binary ? "base64" : "utf8"), ...(binary ? { encoding: "base64" as const } : {}), ...(mode !== 0o644 ? { mode } : {}) });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readLibrarySnapshot(
  root: string,
  options: { installedSkills?: string; resolveMissing?: typeof resolveSkill } = {},
) {
  const nested = join(root, "skills");
  const skillsRoot = (await stat(nested).catch(() => null))?.isDirectory() ? nested : root;
  const manifestPath = join(skillsRoot, "skills-sh.json");
  const originalManifest = await readFile(manifestPath, "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; });
  const manifest: unknown = JSON.parse(originalManifest);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("The library skills-sh.json must map skill names to sources.");
  const listed = Object.entries(manifest);
  const custom = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name);
  const entries: Array<{ name: string; source: string; kind: "custom" | "third-party"; directory?: string }> = [];
  for (const [name, source] of listed) {
    safeName(name);
    if (typeof source !== "string" || !source.trim()) throw new Error(`Library skill ${name} has no source.`);
    entries.push({ name, source, kind: "third-party", directory: join(options.installedSkills ?? join(homedir(), ".agents/skills"), name) });
  }
  for (const name of custom) {
    const directory = join(skillsRoot, name);
    if (!(await stat(join(directory, "SKILL.md")).catch(() => null))?.isFile()) continue;
    safeName(name);
    if (entries.some(entry => entry.name === name)) throw new Error(`The library lists ${name} as both a repository skill and a third-party skill.`);
    entries.push({ name, source: `${basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-")}:skills/${name}`, kind: "custom", directory });
  }
  if (!entries.length) throw new Error("The library has no skills to synchronize.");
  const skills: LibrarySnapshotSkill[] = await Promise.all(entries.map(async entry => {
    const exists = await stat(join(entry.directory!, "SKILL.md")).catch(() => null);
    const files = exists?.isFile()
      ? await collectSkillFiles(await realpath(entry.directory!))
      : (await (options.resolveMissing ?? resolveSkill)(entry.source, entry.name)).files;
    const instructions = files.find(file => file.path === "SKILL.md")?.content;
    const frontmatter = instructions?.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
    const metadata = frontmatter ? parseYaml(frontmatter[1]) : null;
    if (metadata?.name !== entry.name || typeof metadata.description !== "string")
      throw new Error(`Library skill ${entry.name} has invalid or mismatched SKILL.md metadata.`);
    return { name: entry.name, title: entry.name, source: entry.source, kind: entry.kind, files };
  }));
  if (originalManifest !== await readFile(manifestPath, "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; }))
    throw new Error("The library changed while its skills were being read. The next sync will retry.");
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, revision: librarySnapshotRevision(skills) };
}

export async function readLibraryLink(home: string): Promise<LibraryLink | undefined> {
  return readFile(join(home, "library-link.json"), "utf8").then(value => JSON.parse(value)).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
}

export async function saveLibraryLink(home: string, link: LibraryLink) {
  await mkdir(home, { recursive: true });
  const path = join(home, "library-link.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(link, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

export async function syncLinkedLibrary(
  home: string,
  publish: (payload: { id: string; name: string; revision: string; skills: LibrarySnapshotSkill[]; expectedRevision?: string }) => Promise<{ accepted: boolean; revision: string }>,
) {
  const link = await readLibraryLink(home);
  if (!link) return;
  try {
    const snapshot = await readLibrarySnapshot(link.root);
    if (snapshot.revision === link.revision) {
      if (link.lastError) await saveLibraryLink(home, { ...link, lastError: undefined });
      return;
    }
    const result = await publish({ id: link.id, name: link.name, expectedRevision: link.revision, ...snapshot });
    if (!result.accepted || result.revision !== snapshot.revision)
      throw new Error("Equip did not accept the library’s complete skill revision.");
    await saveLibraryLink(home, { ...link, revision: result.revision, lastSync: new Date().toISOString() });
    return true;
  } catch (error) {
    await saveLibraryLink(home, { ...link, lastError: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export async function connectLibrary(home: string, path: string, name?: string) {
  const root = await realpath(resolve(path));
  // Validate before replacing a working link. No instructions or credentials are changed.
  await readLibrarySnapshot(root);
  name = name || basename(root);
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!id) throw new Error("The library needs a name.");
  const previous = await readLibraryLink(home);
  if (previous && previous.id !== id) throw new Error("Unlink the existing library before connecting another one.");
  await saveLibraryLink(home, { id, name, root });
}

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type {
  DesiredState,
  Receipt,
  Skill,
  SkillFile,
} from "../shared/types.ts";

export interface AgentTarget {
  id: string;
  name?: string;
  path: string;
  profile?: string;
  project?: string;
  deviceId?: string;
  aliases?: Array<{ profile: string; path: string }>;
}
interface LedgerEntry {
  skillId: string;
  agent: string;
  profile?: string;
  project?: string;
  revision: string;
  files: Record<string, string>;
  path: string;
}
interface Ledger {
  generation: number;
  installs: Record<string, LedgerEntry>;
}
interface Journal {
  destination: string;
  stage: string;
  oldPath: string;
  hadOld: boolean;
  revision: string;
  obsoletePath?: string;
}

const digest = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const keyFor = (skill: Skill, target: AgentTarget) =>
  [skill.id, target.id, target.profile ?? "", target.project ?? ""].join(":");
function enabledFor(skill: Skill, target: AgentTarget) {
  const matches = skill.targets.filter(
    (r) =>
      (!target.deviceId || r.deviceId === target.deviceId) &&
      r.agent === target.id &&
      (!r.profile || r.profile === target.profile) &&
      (!r.project || r.project === target.project),
  );
  return matches.length ? matches[matches.length - 1].enabled : true;
}
function safeName(name: string) {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  )
    throw new Error(`Unsafe skill name: ${name}`);
}
function safePath(root: string, path: string) {
  const target = resolve(root, path);
  if (target !== resolve(root) && !target.startsWith(resolve(root) + sep))
    throw new Error(`Unsafe skill path: ${path}`);
  return target;
}
async function loadLedger(home: string): Promise<Ledger> {
  return JSON.parse(
    await readFile(join(home, "ledger.json"), "utf8").catch(
      () => '{"generation":0,"installs":{}}',
    ),
  );
}
async function saveJsonAtomic(path: string, value: unknown, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode });
  await rename(temp, path);
}

async function snapshot(
  root: string,
): Promise<{ files: SkillFile[]; hashes: Record<string, string> }> {
  const files: SkillFile[] = [];
  const hashes: Record<string, string> = {};
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(
      (error) => (error?.code === "ENOENT" ? [] : Promise.reject(error)),
    )) {
      const full = join(dir, entry.name);
      const path = full
        .slice(root.length + 1)
        .split("\\")
        .join("/");
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        const link = await readlink(full);
        const content = Buffer.from(link).toString("base64");
        files.push({
          path,
          content,
          encoding: "base64",
          mode: info.mode & 0o777,
        });
        hashes[path] = `symlink:${digest(link)}`;
      } else if (info.isDirectory()) await walk(full);
      else if (info.isFile()) {
        const data = await readFile(full);
        const binary = !Buffer.from(data.toString("utf8"), "utf8").equals(data);
        files.push({
          path,
          content: data.toString(binary ? "base64" : "utf8"),
          ...(binary ? { encoding: "base64" as const } : {}),
          mode: info.mode & 0o777,
        });
        hashes[path] = `${info.mode & 0o777}:${digest(data)}`;
      }
    }
  }
  await walk(root);
  return { files, hashes };
}
function desiredHashes(files: SkillFile[]) {
  const result: Record<string, string> = {};
  for (const file of files) {
    const data = Buffer.from(
      file.content,
      file.encoding === "base64" ? "base64" : "utf8",
    );
    result[file.path] = `${file.mode ?? 0o644}:${digest(data)}`;
  }
  return result;
}
function differs(
  current: Record<string, string>,
  owned?: Record<string, string>,
) {
  const keys = new Set([...Object.keys(current), ...Object.keys(owned ?? {})]);
  return [...keys].some((key) => current[key] !== owned?.[key]);
}
async function writeFiles(root: string, files: SkillFile[]) {
  for (const file of files) {
    const dest = safePath(root, file.path);
    const data = Buffer.from(
      file.content,
      file.encoding === "base64" ? "base64" : "utf8",
    );
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, data, { mode: file.mode ?? 0o644 });
    if (file.mode) await chmod(dest, file.mode);
  }
}

async function recover(home: string) {
  const path = join(home, "transaction.json");
  const journal = JSON.parse(
    await readFile(path, "utf8").catch(() => "null"),
  ) as Journal | null;
  if (!journal) return;
  const ledger = await loadLedger(home);
  const committed = Object.values(ledger.installs).some(
    (entry) =>
      entry.path === journal.destination && entry.revision === journal.revision,
  );
  if (committed) {
    await rm(journal.oldPath, { recursive: true, force: true });
    if (journal.obsoletePath)
      await rm(journal.obsoletePath, { recursive: true, force: true });
  } else if (await lstat(journal.oldPath).catch(() => null)) {
    await rm(journal.destination, { recursive: true, force: true });
    await rename(journal.oldPath, journal.destination);
  } else if (!journal.hadOld)
    await rm(journal.destination, { recursive: true, force: true });
  await rm(journal.stage, { recursive: true, force: true });
  await rm(path, { force: true });
}

async function install(
  skill: Skill,
  target: AgentTarget,
  previous: LedgerEntry | undefined,
  action: string | undefined,
  home: string,
): Promise<{
  entry?: LedgerEntry;
  release?: boolean;
  receipt: Receipt;
  oldPath?: string;
  obsoletePath?: string;
}> {
  safeName(skill.name);
  const destination = join(target.path, skill.name);
  const timestamp = new Date().toISOString();
  const base = {
    skillId: skill.id,
    agent: target.id,
    profile: target.profile,
    project: target.project,
    revision: skill.revision,
    path: destination,
    timestamp,
  };
  const obsoletePath =
    previous?.path !== destination ? previous?.path : undefined;
  if (obsoletePath) {
    const oldInfo = await lstat(obsoletePath).catch(() => null);
    const oldSnapshot = oldInfo?.isSymbolicLink()
      ? { files: [], hashes: { ".": "symlink" } }
      : await snapshot(obsoletePath);
    const oldChanged =
      oldInfo?.isSymbolicLink() || differs(oldSnapshot.hashes, previous?.files);
    const destinationInfo = await lstat(destination).catch(() => null);
    const destinationSnapshot = destinationInfo?.isSymbolicLink()
      ? { files: [], hashes: { ".": "symlink" } }
      : await snapshot(destination);
    if (oldChanged || destinationInfo) {
      const conflictPath = destinationInfo ? destination : obsoletePath;
      const localFiles = destinationInfo
        ? destinationSnapshot.files
        : oldSnapshot.files;
      if (action === "import" || action === "preserve")
        return {
          release: true,
          receipt: {
            ...base,
            path: conflictPath,
            revision: previous?.revision ?? "",
            status: "conflicted",
            message:
              action === "import"
                ? "Imported local files and released management"
                : "Preserved local files and released management",
            localFiles,
          },
        };
      if (
        action !== "replace" ||
        oldInfo?.isSymbolicLink() ||
        destinationInfo?.isSymbolicLink()
      )
        return {
          entry: previous,
          receipt: {
            ...base,
            path: conflictPath,
            revision: previous?.revision ?? "",
            status: "conflicted",
            message: destinationInfo
              ? "New skill name is already occupied and was preserved"
              : "Managed skill cannot be renamed because its existing directory changed",
            localFiles,
          },
        };
      if (oldChanged) {
        const backup = join(
          home,
          "backups",
          `${Date.now()}-${basename(obsoletePath)}-${randomUUID()}`,
        );
        await cp(obsoletePath, backup, {
          recursive: true,
          dereference: false,
          preserveTimestamps: true,
        });
      }
    }
  }
  const rootInfo = await lstat(destination).catch(() => null);
  // Nova's existing installs often point at its shared folder. Verify them,
  // but leave ownership with Nova so removals cannot destroy preexisting work.
  let linkedLocalFiles: SkillFile[] | undefined;
  if (rootInfo && !previous && skill.librarySourceId) {
    const existing = await snapshot(await realpath(destination));
    linkedLocalFiles = existing.files;
    if (!differs(existing.hashes, desiredHashes(skill.files)))
      return { receipt: { ...base, status: "synchronized", managed: false,
        message: "Existing installation matches; original folder or link retained" } };
  }
  if (rootInfo?.isSymbolicLink())
    return {
      entry: previous,
      receipt: {
        ...base,
        revision: previous?.revision ?? "",
        status: "conflicted",
        message: "Skill destination is a symbolic link and was preserved",
        localFiles: linkedLocalFiles ?? [],
      },
    };
  const current = await snapshot(destination);
  const conflict = differs(
    current.hashes,
    obsoletePath ? undefined : previous?.files,
  );
  if (
    !conflict &&
    previous?.path === destination &&
    previous.revision === skill.revision &&
    !differs(desiredHashes(skill.files), previous.files)
  )
    return { entry: previous, receipt: { ...base, status: "synchronized" } };
  if (conflict && action === "import")
    return {
      release: true,
      receipt: {
        ...base,
        revision: previous?.revision ?? "",
        status: "conflicted",
        message: "Imported local files and preserved destination",
        localFiles: current.files,
      },
    };
  if (conflict && action !== "replace")
    return {
      release: action === "preserve",
      entry: action === "preserve" ? undefined : previous,
      receipt: {
        ...base,
        revision: previous?.revision ?? "",
        status: "conflicted",
        message:
          action === "preserve"
            ? "Preserved local files"
            : "Local directory differs; choose preserve, import, or replace",
        localFiles: current.files,
      },
    };
  if (conflict) {
    const backup = join(
      home,
      "backups",
      `${Date.now()}-${skill.name}-${randomUUID()}`,
    );
    await cp(destination, backup, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
  }
  const stage = `${destination}.equip-stage-${randomUUID()}`;
  const oldPath = `${destination}.equip-old-${randomUUID()}`;
  await mkdir(stage, { recursive: true });
  await writeFiles(stage, skill.files);
  const hadOld = !!(await lstat(destination).catch(() => null));
  await saveJsonAtomic(join(home, "transaction.json"), {
    destination,
    stage,
    oldPath,
    hadOld,
    revision: skill.revision,
    obsoletePath,
  } satisfies Journal);
  try {
    if (hadOld) await rename(destination, oldPath);
    await mkdir(dirname(destination), { recursive: true });
    await rename(stage, destination);
  } catch (error) {
    if (await lstat(oldPath).catch(() => null)) {
      await rm(destination, { recursive: true, force: true });
      await rename(oldPath, destination);
    }
    throw error;
  }
  const entry: LedgerEntry = {
    skillId: skill.id,
    agent: target.id,
    profile: target.profile,
    project: target.project,
    revision: skill.revision,
    files: desiredHashes(skill.files),
    path: destination,
  };
  return {
    entry,
    oldPath,
    obsoletePath,
    receipt: { ...base, status: "synchronized" },
  };
}

export async function synchronize(
  desired: DesiredState,
  targets: AgentTarget[],
  home: string,
): Promise<Receipt[]> {
  await mkdir(home, { recursive: true });
  const lockPath = join(home, "sync.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    const owner = JSON.parse(
      await readFile(lockPath, "utf8").catch(() => "{}"),
    ) as { pid?: number };
    let alive = false;
    if (owner.pid)
      try {
        process.kill(owner.pid, 0);
        alive = true;
      } catch {}
    if (alive) throw new Error("A synchronization is already running");
    await rm(lockPath, { force: true });
    lock = await open(lockPath, "wx", 0o600);
  }
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
    );
    await recover(home);
    const ledger = await loadLedger(home);
    const next: Ledger = {
      generation: ledger.generation,
      installs: { ...ledger.installs },
    };
    const receipts: Receipt[] = [];
    for (const target of targets)
      for (const skill of desired.skills.filter(
        (s) => s.enabled && enabledFor(s, target),
      )) {
        const key = keyFor(skill, target);
        try {
          const result = await install(
            skill,
            target,
            ledger.installs[key],
            desired.resolutions[key] ??
              desired.resolutions[`${skill.id}:${target.id}`],
            home,
          );
          if (result.release) {
            delete next.installs[key];
            await saveJsonAtomic(join(home, "ledger.json"), next);
          } else if (result.entry) {
            next.installs[key] = result.entry;
            await saveJsonAtomic(join(home, "ledger.json"), next);
            if (result.oldPath)
              await rm(result.oldPath, { recursive: true, force: true }).catch(
                () => {},
              );
            if (result.obsoletePath)
              await rm(result.obsoletePath, {
                recursive: true,
                force: true,
              }).catch(() => {});
            if (result.oldPath || result.obsoletePath)
              await rm(join(home, "transaction.json"), { force: true }).catch(
                () => {},
              );
          }
          receipts.push(result.receipt);
        } catch (error) {
          if (ledger.installs[key]) next.installs[key] = ledger.installs[key];
          else delete next.installs[key];
          await recover(home).catch(() => {});
          receipts.push({
            skillId: skill.id,
            agent: target.id,
            profile: target.profile,
            project: target.project,
            revision: ledger.installs[key]?.revision ?? "",
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
            path: ledger.installs[key]?.path,
            timestamp: new Date().toISOString(),
          });
        }
      }
    const wanted = new Set(
      targets.flatMap((t) =>
        desired.skills
          .filter((s) => s.enabled && enabledFor(s, t))
          .map((s) => keyFor(s, t)),
      ),
    );
    for (const [key, old] of Object.entries(ledger.installs))
      if (!wanted.has(key)) {
        if (!(await lstat(old.path).catch(() => null))) {
          delete next.installs[key];
          receipts.push({ skillId: old.skillId, agent: old.agent,
            profile: old.profile, project: old.project, revision: old.revision,
            status: "synchronized", message: "Released missing installation",
            path: old.path, timestamp: new Date().toISOString() });
          continue;
        }
        const oldInfo = await lstat(old.path);
        const current = oldInfo.isSymbolicLink()
          ? { files: [], hashes: { ".": "symlink" } }
          : await snapshot(old.path);
        const changed = oldInfo.isSymbolicLink() || differs(current.hashes, old.files);
        const action =
          desired.resolutions[key] ??
          desired.resolutions[`${old.skillId}:${old.agent}`];
        if (!changed || action === "replace") {
          if (changed) {
            const backup = join(
              home,
              "backups",
              `${Date.now()}-removed-${basename(old.path)}-${randomUUID()}`,
            );
            await cp(old.path, backup, {
              recursive: true,
              dereference: false,
              preserveTimestamps: true,
            });
          }
          await rm(old.path, { recursive: true, force: true });
          delete next.installs[key];
          receipts.push({
            skillId: old.skillId,
            agent: old.agent,
            profile: old.profile,
            project: old.project,
            revision: old.revision,
            status: "synchronized",
            message: changed
              ? "Backed up and removed local files"
              : "Removed managed skill",
            path: old.path,
            timestamp: new Date().toISOString(),
          });
        } else if (action === "preserve" || action === "import") {
          delete next.installs[key];
          receipts.push({
            skillId: old.skillId,
            agent: old.agent,
            profile: old.profile,
            project: old.project,
            revision: old.revision,
            status: "conflicted",
            message:
              action === "import"
                ? "Imported local files and released management"
                : "Preserved local files and released management",
            path: old.path,
            timestamp: new Date().toISOString(),
            localFiles: current.files,
          });
        } else
          receipts.push({
            skillId: old.skillId,
            agent: old.agent,
            profile: old.profile,
            project: old.project,
            revision: old.revision,
            status: "conflicted",
            message:
              "Managed skill was not removed because local files changed",
            path: old.path,
            timestamp: new Date().toISOString(),
            localFiles: current.files,
          });
      }
    next.generation = desired.generation;
    await saveJsonAtomic(join(home, "ledger.json"), next);
    return receipts;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

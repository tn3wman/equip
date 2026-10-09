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
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileHashes, sameInstalledFileHashes } from "./file-state.ts";
import { portableFilesRevision } from "./file-state.ts";
import type {
  DesiredState,
  Receipt,
  Skill,
  SkillFile,
} from "../shared/types.ts";
import type { RecoveryArchive } from "./recovery.ts";
import { renameReplacing } from "./atomic.ts";

export interface AgentTarget {
  id: string;
  name?: string;
  path: string;
  profile?: string;
  project?: string;
  deviceId?: string;
  aliases?: Array<{ profile: string; path: string }>;
  detection?: "installation" | "configuration";
  detectionPath?: string;
}
interface LedgerEntry {
  skillId: string;
  agent: string;
  profile?: string;
  project?: string;
  revision: string;
  files: Record<string, string>;
  path: string;
  observed?: true;
  canonicalPath?: string;
  transactionId?: string;
  copied?: true;
  localOwned?: true;
  retainedFromCanonical?: string;
}

function excludedDestination(
  desired: DesiredState,
  destination: { id?: string; agent?: string; profile?: string; project?: string },
) {
  const agent = destination.id ?? destination.agent;
  return (desired.excludedAgents ?? []).some(excluded =>
    excluded.agent === agent && excluded.profile === destination.profile &&
    excluded.project === destination.project);
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
  transactionId?: string;
  skillId?: string;
  expectedFiles?: Record<string, string>;
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
  await renameReplacing(temp, path);
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
  return fileHashes(files);
}
function differs(
  current: Record<string, string>,
  owned?: Record<string, string>,
) {
  return !sameInstalledFileHashes(current, owned);
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

interface CanonicalState {
  path: string;
  hashes: Record<string, string>;
  transactionId?: string;
  oldPath?: string;
  conflict?: { files: SkillFile[]; message: string };
}

async function pointsTo(path: string, expected: string) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isSymbolicLink()) return false;
  const link = await readlink(path).catch(() => "");
  const parent = await realpath(dirname(path));
  const target = await realpath(expected).catch(() => resolve(expected));
  return resolve(parent, link) === target;
}

async function createManagedLink(source: string, destination: string) {
  const target = process.platform === "win32"
    ? source
    : relative(await realpath(dirname(destination)), await realpath(source));
  await symlink(target, destination, process.platform === "win32" ? "junction" : "dir");
}

async function archiveChanged(
  archive: RecoveryArchive | undefined,
  skillId: string,
  current: { files: SkillFile[]; hashes: Record<string, string> },
  path: string,
) {
  if (Object.values(current.hashes).some((hash) => hash.startsWith("symlink:")))
    throw new Error("Local files contain a symbolic link that cannot be archived safely");
  if (!archive)
    throw new Error("Local files require recovery archiving before replacement");
  await archive({ skillId, files: current.files, path });
  if (differs((await snapshot(path)).hashes,current.hashes))
    throw new Error('Local files changed during archival and were preserved');
}

async function prepareCanonical(
  skill: Skill,
  home: string,
  entries: LedgerEntry[],
  replace: boolean,
  archive?: RecoveryArchive,
): Promise<CanonicalState> {
  safeName(skill.name);
  const path = join(home, "skills", skill.name);
  const hashes = desiredHashes(skill.files);
  const info = await lstat(path).catch(() => null);
  if (info?.isSymbolicLink())
    return {
      path,
      hashes,
      conflict: {
        files: [],
        message: "Canonical skill path is a symbolic link and was preserved",
      },
    };
  if (info) {
    const current = await snapshot(path);
    if (!differs(current.hashes, hashes)) return { path, hashes };
    const baselines = entries
      .filter((entry) => entry.canonicalPath === path || entry.retainedFromCanonical === path || entry.observed)
      .map((entry) => entry.files);
    if (
      (!baselines.length ||
        baselines.every((baseline) => differs(current.hashes, baseline))) &&
      !replace
    )
      return {
        path,
        hashes,
        conflict: {
          files: current.files,
          message: "Canonical skill changed locally and was preserved",
        },
      };
    const locallyChanged = !baselines.some((baseline) => !differs(current.hashes, baseline));
    if (locallyChanged && (replace || entries.some((entry) => entry.canonicalPath === path && !entry.observed)))
      await archiveChanged(archive, skill.id, current, path);
  }
  const stage = `${path}.equip-stage-${randomUUID()}`;
  const oldPath = `${path}.equip-old-${randomUUID()}`;
  const transactionId = randomUUID();
  await mkdir(stage, { recursive: true });
  await writeFiles(stage, skill.files);
  await saveJsonAtomic(join(home, "transaction.json"), {
    destination: path,
    stage,
    oldPath,
    hadOld: !!info,
    revision: skill.revision,
    transactionId,
    skillId: skill.id,
    expectedFiles: hashes,
  } satisfies Journal);
  if (info) await rename(path, oldPath);
  await mkdir(dirname(path), { recursive: true });
  await rename(stage, path);
  await rm(oldPath, { recursive: true, force: true });
  await rm(join(home, "transaction.json"), { force: true });
  return { path, hashes, transactionId };
}

async function recover(home: string, archive?: RecoveryArchive) {
  const path = join(home, "transaction.json");
  const journal = JSON.parse(
    await readFile(path, "utf8").catch(() => "null"),
  ) as Journal | null;
  if (!journal) return;
  const ledger = await loadLedger(home);
  const committed = Object.values(ledger.installs).some(
    (entry) =>
      (entry.path === journal.destination ||
        entry.canonicalPath === journal.destination) &&
      entry.revision === journal.revision &&
      (!journal.transactionId || entry.transactionId === journal.transactionId),
  );
  if (committed) {
    await rm(journal.oldPath, { recursive: true, force: true });
    if (journal.obsoletePath)
      await rm(journal.obsoletePath, { recursive: true, force: true });
  } else if (await lstat(journal.oldPath).catch(() => null)) {
    const destinationInfo = await lstat(journal.destination).catch(() => null);
    if (destinationInfo) {
      if (!journal.expectedFiles || !journal.skillId)
        throw new Error("Interrupted legacy skill update requires manual recovery; destination was preserved");
      const current = await snapshot(journal.destination);
      if (differs(current.hashes, journal.expectedFiles))
        await archiveChanged(archive, journal.skillId, current, journal.destination);
      await rm(journal.destination, { recursive: true, force: true });
    }
    await rename(journal.oldPath, journal.destination);
  } else if (!journal.hadOld) {
    const destinationInfo = await lstat(journal.destination).catch(() => null);
    if (destinationInfo) {
      if (!journal.expectedFiles || !journal.skillId)
        throw new Error("Interrupted legacy skill install requires manual recovery; destination was preserved");
      const current = await snapshot(journal.destination);
      if (differs(current.hashes, journal.expectedFiles))
        await archiveChanged(archive, journal.skillId, current, journal.destination);
      await rm(journal.destination, { recursive: true, force: true });
    }
  }
  await rm(journal.stage, { recursive: true, force: true });
  await rm(path, { force: true });
}

async function install(
  skill: Skill,
  target: AgentTarget,
  previous: LedgerEntry | undefined,
  action: string | undefined,
  home: string,
  canonical: CanonicalState,
  canonicalSnapshots: Map<
    string,
    Promise<{ files: SkillFile[]; hashes: Record<string, string> }>
  >,
  archive?: RecoveryArchive,
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
  if (canonical.conflict)
    return {
      ...(action === "import" || action === "preserve"
        ? { release: true }
        : { entry: previous }),
      receipt: {
        ...base,
        revision: previous?.revision ?? "",
        status: "conflicted",
        message:
          action === "import"
            ? "Imported local files and released management"
            : action === "preserve"
              ? "Preserved local files and released management"
              : canonical.conflict.message,
        localFiles: canonical.conflict.files,
      },
    };
  const desired = desiredHashes(skill.files);
  const obsoletePath =
    previous?.path !== destination ? previous?.path : undefined;
  if (obsoletePath) {
    let oldCanonicalSnapshot:
      | Promise<{ files: SkillFile[]; hashes: Record<string, string> }>
      | undefined;
    if (previous?.canonicalPath) {
      oldCanonicalSnapshot = canonicalSnapshots.get(previous.canonicalPath);
      if (!oldCanonicalSnapshot) {
        oldCanonicalSnapshot = snapshot(previous.canonicalPath);
        canonicalSnapshots.set(previous.canonicalPath, oldCanonicalSnapshot);
      }
    }
    const oldInfo = await lstat(obsoletePath).catch(() => null);
    const oldSnapshot = oldInfo?.isSymbolicLink()
      ? previous?.canonicalPath && await pointsTo(obsoletePath, previous.canonicalPath)
        ? await oldCanonicalSnapshot!
        : { files: [], hashes: { ".": "symlink" } }
      : await snapshot(obsoletePath);
    const oldCanonicalChanged = previous?.canonicalPath
      ? differs((await oldCanonicalSnapshot!).hashes, previous.files)
      : false;
    const oldChanged = previous?.canonicalPath
      ? previous.copied
        ? differs(oldSnapshot.hashes, previous.files)
        : !(await pointsTo(obsoletePath, previous.canonicalPath)) || oldCanonicalChanged
      : oldInfo?.isSymbolicLink() || differs(oldSnapshot.hashes, previous?.files);
    const destinationInfo = await lstat(destination).catch(() => null);
    const destinationSnapshot = destinationInfo?.isSymbolicLink()
      ? { files: [], hashes: { ".": "symlink" } }
      : await snapshot(destination);
    if (previous?.canonicalPath && !previous.copied && oldInfo?.isSymbolicLink() &&
        destinationInfo?.isSymbolicLink() &&
        await pointsTo(obsoletePath, previous.canonicalPath)) {
      const [oldTarget, destinationTarget, previousCanonicalTarget, canonicalTarget] =
        await Promise.all([
          realpath(obsoletePath).catch(() => undefined),
          realpath(destination).catch(() => undefined),
          realpath(previous.canonicalPath).catch(() => undefined),
          realpath(canonical.path).catch(() => undefined),
        ]);
      let canonicalSnapshot = canonicalSnapshots.get(canonical.path);
      if (!canonicalSnapshot) {
        canonicalSnapshot = snapshot(canonical.path);
        canonicalSnapshots.set(canonical.path, canonicalSnapshot);
      }
      if (oldTarget && oldTarget === destinationTarget &&
          oldTarget === previousCanonicalTarget && oldTarget === canonicalTarget &&
          !differs((await canonicalSnapshot).hashes, desired)) {
        const [oldParent, destinationParent] = await Promise.all([
          realpath(dirname(obsoletePath)).catch(() => undefined),
          realpath(dirname(destination)).catch(() => undefined),
        ]);
        const sameDirectoryEntry = !!oldParent && oldParent === destinationParent &&
          basename(obsoletePath) === basename(destination);
        const stage = `${destination}.equip-stage-${randomUUID()}`;
        await createManagedLink(canonical.path, stage);
        try {
          const [stillOld, stillDestination] = await Promise.all([
            realpath(obsoletePath).catch(() => undefined),
            realpath(destination).catch(() => undefined),
          ]);
          if (stillOld !== oldTarget || stillDestination !== destinationTarget ||
              !await pointsTo(obsoletePath, previous.canonicalPath))
            throw new Error("Managed skill alias changed during synchronization and was preserved");
          await rename(stage, destination);
        } catch (error) {
          await rm(stage, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        return {
          entry: {
            ...previous,
            path: destination,
            revision: skill.revision,
            files: canonical.hashes,
            canonicalPath: canonical.path,
            retainedFromCanonical: undefined,
            transactionId: canonical.transactionId ?? previous.transactionId,
          },
          ...(sameDirectoryEntry ? {} : { obsoletePath }),
          receipt: { ...base, status: "synchronized" },
        };
      }
    }
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
        (oldInfo?.isSymbolicLink() && !previous?.canonicalPath) ||
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
        const archivedPath = previous?.canonicalPath && await pointsTo(obsoletePath, previous.canonicalPath)
          ? previous.canonicalPath : obsoletePath;
        await archiveChanged(archive, skill.id, await snapshot(archivedPath), archivedPath);
      }
    }
  }
  const rootInfo = await lstat(destination).catch(() => null);
  let migratingObserved = false;
  let replacingChangedPointer = false;
  if (previous?.observed) {
    const pointer = await realpath(destination).catch(() => undefined);
    // Another agent can share the same physical skill root. If this pass
    // already redirected that root, adopt its verified Equip link too.
    if (pointer && pointer !== previous.canonicalPath && await pointsTo(destination, canonical.path) &&
        !differs((await snapshot(pointer)).hashes, desired)) {
      const { observed: _observed, ...managed } = previous;
      return { entry: { ...managed, canonicalPath: canonical.path, revision: skill.revision, files: desired }, receipt: { ...base, status: "synchronized" } };
    }
    if (!pointer || pointer !== previous.canonicalPath) {
      if (action !== "replace")
        return {
          entry: previous,
          receipt: {
            ...base,
            revision: previous.revision,
            status: "conflicted",
            managed: false,
            message: "Observed installation pointer changed and was preserved",
            localFiles: [],
          },
        };
      replacingChangedPointer = true;
    }
    if (!replacingChangedPointer) {
      const current = await snapshot(pointer!);
      const matchesDesired = !differs(current.hashes, desired);
      const matchesBaseline = !differs(current.hashes, previous.files);
      if (matchesDesired) migratingObserved = true;
      if (action === "import" || action === "preserve")
        return {
          release: true,
          receipt: {
            ...base,
            revision: previous.revision,
            status: "conflicted",
            managed: false,
            message:
              action === "import"
                ? "Imported local files and released observation"
                : "Preserved local files and released observation",
            localFiles: current.files,
          },
        };
      if (!matchesDesired && !matchesBaseline && action !== "replace")
        return {
          entry: previous,
          receipt: {
            ...base,
            revision: previous.revision,
            status: "conflicted",
            managed: false,
            message: "Observed installation changed locally and was preserved",
            localFiles: current.files,
          },
        };
      if (!matchesDesired) {
        await archiveChanged(archive, skill.id, current, pointer!);
      }
      // Replace only the installation, never the repository or external source
      // behind a preexisting link. The original files remain in place.
      migratingObserved = true;
    }
  }
  if (!migratingObserved && !replacingChangedPointer && previous?.canonicalPath && previous.path === destination) {
    let intact = previous.copied
      ? !!rootInfo && !rootInfo.isSymbolicLink() &&
        !differs((await snapshot(destination)).hashes, previous.files)
      : await pointsTo(destination, previous.canonicalPath);
    if (!intact && !previous.copied && rootInfo?.isSymbolicLink()) {
      const [destinationTarget, previousCanonicalTarget] = await Promise.all([
        realpath(destination).catch(() => undefined),
        realpath(previous.canonicalPath).catch(() => undefined),
      ]);
      let canonicalSnapshot = canonicalSnapshots.get(previous.canonicalPath);
      if (!canonicalSnapshot) {
        canonicalSnapshot = snapshot(previous.canonicalPath);
        canonicalSnapshots.set(previous.canonicalPath, canonicalSnapshot);
      }
      if (destinationTarget && destinationTarget === previousCanonicalTarget &&
          !differs((await canonicalSnapshot).hashes, desired)) {
        const stage = `${destination}.equip-stage-${randomUUID()}`;
        await createManagedLink(canonical.path, stage);
        try {
          if (await realpath(destination).catch(() => undefined) !== previousCanonicalTarget)
            throw new Error("Managed skill link changed during synchronization and was preserved");
          await rename(stage, destination);
        } catch (error) {
          await rm(stage, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        intact = true;
      }
    }
    if (!intact) {
      if (action !== "replace")
        return {
          entry: previous,
          receipt: {
            ...base,
            revision: previous.revision,
            status: "conflicted",
            message: "Managed skill link changed and was preserved",
            localFiles: rootInfo?.isSymbolicLink()
              ? []
              : (await snapshot(destination)).files,
          },
        };
      replacingChangedPointer = true;
    }
    if (!replacingChangedPointer) {
      if (previous.copied) {
        const transactionId = randomUUID();
        const stage = `${destination}.equip-stage-${transactionId}`;
        const oldPath = `${destination}.equip-old-${transactionId}`;
        await cp(canonical.path, stage, {
          recursive: true,
          preserveTimestamps: true,
        });
        await saveJsonAtomic(join(home, "transaction.json"), {
          destination,
          stage,
          oldPath,
          hadOld: true,
          revision: skill.revision,
          transactionId,
          skillId: skill.id,
          expectedFiles: canonical.hashes,
        } satisfies Journal);
        await rename(destination, oldPath);
        await rename(stage, destination);
        return {
          entry: {
            ...previous,
            revision: skill.revision,
            files: canonical.hashes,
            canonicalPath: canonical.path,
            retainedFromCanonical: undefined,
            transactionId,
          },
          oldPath,
          receipt: { ...base, status: "synchronized" },
        };
      }
      if (resolve(previous.canonicalPath) !== resolve(canonical.path)) {
        const stage = `${destination}.equip-stage-${randomUUID()}`;
        await createManagedLink(canonical.path, stage);
        await rename(stage, destination);
      }
      return {
        entry: {
          ...previous,
          revision: skill.revision,
          files: canonical.hashes,
          canonicalPath: canonical.path,
          retainedFromCanonical: undefined,
          transactionId: canonical.transactionId ?? previous.transactionId,
        },
        receipt: { ...base, status: "synchronized" },
      };
    }
  }
  // Exact preexisting installs can safely converge on the canonical store.
  // Replacing a link moves only the link itself, never its external target.
  let linkedLocalFiles: SkillFile[] | undefined;
  let replacingUnownedLink = false;
  let matchingPreexisting = false;
  if (rootInfo && !previous) {
    const existing = await snapshot(await realpath(destination));
    linkedLocalFiles = existing.files;
    matchingPreexisting = !differs(existing.hashes, desired);
  }
  if (rootInfo?.isSymbolicLink() && !migratingObserved && !matchingPreexisting) {
    linkedLocalFiles ??= (await snapshot(await realpath(destination))).files;
    if (action === "import" || action === "preserve")
      return {
        release: true,
        receipt: {
          ...base,
          revision: previous?.revision ?? "",
          status: "conflicted",
          managed: false,
          message:
            action === "import"
              ? "Imported linked local files and released management"
              : "Preserved local skill link and released management",
          localFiles: linkedLocalFiles ?? [],
        },
      };
    if (action !== "replace")
      return {
        entry: previous,
        receipt: {
          ...base,
          revision: previous?.revision ?? "",
          status: "conflicted",
          managed: false,
          message:
            "Existing skill link has no Equip baseline; choose preserve, import, or replace",
          localFiles: linkedLocalFiles ?? [],
        },
      };
    await archiveChanged(archive, skill.id, {
      files: linkedLocalFiles ?? [],
      hashes: (await snapshot(await realpath(destination))).hashes,
    }, destination);
    replacingUnownedLink = true;
  }
  const current = await snapshot(destination);
  const conflict = !migratingObserved && !replacingUnownedLink &&
    !matchingPreexisting && differs(
    current.hashes,
    obsoletePath ? undefined : previous?.files,
  );
  if (
    !conflict && !migratingObserved &&
    previous?.canonicalPath &&
    previous?.path === destination &&
    previous.revision === skill.revision &&
    !differs(desired, previous.files)
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
    await archiveChanged(archive, skill.id, current, destination);
  }
  await mkdir(dirname(destination), { recursive: true });
  const transactionId = randomUUID();
  const stage = `${destination}.equip-stage-${transactionId}`;
  const oldPath = `${destination}.equip-old-${transactionId}`;
  let copied = false;
  let fallbackMessage: string | undefined;
  try {
    await createManagedLink(canonical.path, stage);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(code))
      throw error;
    copied = true;
    await cp(canonical.path, stage, {
      recursive: true,
      preserveTimestamps: true,
    });
    fallbackMessage = `Installed a managed copy because this platform refused a directory link (${code})`;
  }
  await saveJsonAtomic(join(home, "transaction.json"), {
    destination,
    stage,
    oldPath,
    hadOld: !!rootInfo,
    revision: skill.revision,
    obsoletePath,
    transactionId,
    skillId: skill.id,
    expectedFiles: canonical.hashes,
  } satisfies Journal);
  try {
    if (rootInfo) await rename(destination, oldPath);
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
    files: canonical.hashes,
    path: destination,
    canonicalPath: canonical.path,
    transactionId,
    ...(copied ? { copied: true as const } : {}),
    ...(skill.localOrigin?.deviceId === target.deviceId && skill.localOrigin?.path === await realpath(canonical.path)
      ? { localOwned: true as const } : {}),
  };
  return {
    entry,
    oldPath,
    obsoletePath,
    receipt: { ...base, status: "synchronized", ...(fallbackMessage ? { message: fallbackMessage } : {}) },
  };
}

export async function synchronize(
  desired: DesiredState,
  targets: AgentTarget[],
  home: string,
  archive?: RecoveryArchive,
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
    await recover(home, archive);
    const ledger = await loadLedger(home);
    const next: Ledger = {
      generation: ledger.generation,
      installs: { ...ledger.installs },
    };
    // Retained destinations share one immutable snapshot for each old revision.
    for (const [key, entry] of Object.entries(ledger.installs)) {
      if (!excludedDestination(desired, entry) || !entry.canonicalPath || entry.copied || entry.retainedFromCanonical) continue;
      if (!await pointsTo(entry.path, entry.canonicalPath)) continue;
      const current = await snapshot(entry.canonicalPath);
      const retained = join(home,"retained","skills",entry.skillId,portableFilesRevision(current.files));
      if (!await lstat(retained).catch(() => null)) {
        const retainedStage = `${retained}.equip-stage-${randomUUID()}`;
        await mkdir(dirname(retained),{recursive:true});
        try {
          await cp(entry.canonicalPath,retainedStage,{recursive:true,preserveTimestamps:true});
          if (differs((await snapshot(retainedStage)).hashes,current.hashes) ||
              differs((await snapshot(entry.canonicalPath)).hashes,current.hashes))
            throw new Error("Local files changed while excluding this destination; they were preserved");
          await rename(retainedStage,retained);
        } finally { await rm(retainedStage,{recursive:true,force:true}); }
      }
      const transactionId = randomUUID();
      const stage = `${entry.path}.equip-retained-${transactionId}`;
      try { await createManagedLink(retained,stage); }
      catch (error) { await rm(stage,{recursive:true,force:true}); throw error; }
      if (process.platform === "win32") {
        const old = `${entry.path}.equip-old-${transactionId}`;
        await saveJsonAtomic(join(home,"transaction.json"),{destination:entry.path,stage,oldPath:old,hadOld:true,
          revision:entry.revision,transactionId,skillId:entry.skillId,expectedFiles:entry.files} satisfies Journal);
        await rename(entry.path,old);await rename(stage,entry.path);
      } else await rename(stage,entry.path);
      ledger.installs[key] = {...entry,canonicalPath:retained,retainedFromCanonical:entry.canonicalPath,transactionId,copied:undefined};
      next.installs[key] = ledger.installs[key];
      await saveJsonAtomic(join(home,"ledger.json"),next);
      if (process.platform === "win32") await recover(home,archive);
    }
    const receipts: Receipt[] = [];
    const canonicals = new Map<string, Promise<CanonicalState>>();
    const canonicalSnapshots = new Map<
      string,
      Promise<{ files: SkillFile[]; hashes: Record<string, string> }>
    >();
    for (const target of targets) {
      if (excludedDestination(desired, target)) continue;
      for (const skill of desired.skills.filter(
        (s) => s.enabled && enabledFor(s, target),
      )) {
        const destination = join(target.path, skill.name);
        if (Object.values(ledger.installs).some(entry => entry.skillId === skill.id &&
          entry.path === destination && excludedDestination(desired, entry))) continue;
        const key = keyFor(skill, target);
        try {
          let canonical = canonicals.get(skill.id);
          if (!canonical) {
            canonical = prepareCanonical(
              skill,
              home,
              Object.values(ledger.installs).filter(
                (entry) => entry.skillId === skill.id,
              ),
              Object.entries(desired.resolutions).some(
                ([key, action]) => key.startsWith(`${skill.id}:`) && action === "replace",
              ),
              archive,
            );
            canonicals.set(skill.id, canonical);
          }
          const shared = Object.values(next.installs).find(entry =>
            entry.skillId === skill.id && entry.path === destination && entry.canonicalPath && !entry.observed);
          const previous = ledger.installs[key];
          const sharedPrevious = shared && (!previous || previous.observed && previous.canonicalPath === shared.canonicalPath)
            ? { ...shared, agent: target.id, profile: target.profile, project: target.project }
            : previous;
          const result = await install(
            skill,
            target,
            sharedPrevious,
            desired.resolutions[key] ??
            desired.resolutions[`${skill.id}:${target.id}`],
            home,
            await canonical,
            canonicalSnapshots,
            archive,
          );
          if (result.release) {
            delete next.installs[key];
            await saveJsonAtomic(join(home, "ledger.json"), next);
          } else if (result.entry) {
            const changed = JSON.stringify(next.installs[key]) !== JSON.stringify(result.entry);
            next.installs[key] = result.entry;
            // A receipt is needed on each pass, but an unchanged installation
            // does not need another full ledger write for every agent.
            if (changed) await saveJsonAtomic(join(home, "ledger.json"), next);
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
          await recover(home, archive).catch(() => {});
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
    }
    await recover(home, archive);
    const wanted = new Set(
      targets.flatMap((t) =>
        desired.skills
          .filter((s) => s.enabled && enabledFor(s, t))
          .map((s) => keyFor(s, t)),
      ),
    );
    const removalCanonicalSnapshots = new Map<
      string,
      Promise<{ files: SkillFile[]; hashes: Record<string, string> }>
    >();
    const protectedCanonicals = new Set<string>();
    const canonicalGcCandidates = new Set<string>();
    for (const [key, old] of Object.entries(ledger.installs))
      if (!wanted.has(key)) {
        if (excludedDestination(desired, old)) continue;
        // Several upstream agents can intentionally use the same directory.
        // Release this destination rule without deleting another agent's link.
        if (Object.entries(next.installs).some(([otherKey, entry]) => otherKey !== key && wanted.has(otherKey) && entry.path === old.path)) {
          delete next.installs[key];
          receipts.push({ skillId: old.skillId, agent: old.agent, profile: old.profile,
            project: old.project, revision: old.revision, status: "synchronized",
            path: old.path, timestamp: new Date().toISOString(),
            message: "Released this destination; another selected agent shares the installation" });
          continue;
        }
        if (old.localOwned && old.canonicalPath) protectedCanonicals.add(old.canonicalPath);
        if (old.observed) {
          if (old.canonicalPath) protectedCanonicals.add(old.canonicalPath);
          delete next.installs[key];
          receipts.push({
            skillId: old.skillId,
            agent: old.agent,
            profile: old.profile,
            project: old.project,
            revision: old.revision,
            status: "synchronized",
            managed: false,
            message: "Released observation; preexisting installation retained",
            path: old.path,
            timestamp: new Date().toISOString(),
          });
          continue;
        }
        if (!(await lstat(old.path).catch(() => null))) {
          delete next.installs[key];
          receipts.push({ skillId: old.skillId, agent: old.agent,
            profile: old.profile, project: old.project, revision: old.revision,
            status: "synchronized", message: "Released missing installation",
            path: old.path, timestamp: new Date().toISOString() });
          continue;
        }
        const oldInfo = await lstat(old.path);
        const managedLink = !!old.canonicalPath && !old.copied &&
          await pointsTo(old.path, old.canonicalPath);
        let current = oldInfo.isSymbolicLink()
          ? { files: [], hashes: { ".": "symlink" } }
          : await snapshot(old.path);
        if (managedLink && old.canonicalPath) {
          let canonicalSnapshot = removalCanonicalSnapshots.get(old.canonicalPath);
          if (!canonicalSnapshot) {
            canonicalSnapshot = snapshot(old.canonicalPath);
            removalCanonicalSnapshots.set(old.canonicalPath, canonicalSnapshot);
          }
          current = await canonicalSnapshot;
        }
        const changed = old.canonicalPath
          ? old.copied
            ? differs(current.hashes, old.files)
            : !managedLink || differs(current.hashes, old.files)
          : oldInfo.isSymbolicLink() || differs(current.hashes, old.files);
        const action =
          desired.resolutions[key] ??
          desired.resolutions[`${old.skillId}:${old.agent}`];
        if (!changed || action === "replace") {
          if (changed) {
            const archivedPath = managedLink && old.canonicalPath ? old.canonicalPath : old.path;
            try { await archiveChanged(archive, old.skillId, current, archivedPath); }
            catch (error) {
              if (old.canonicalPath) protectedCanonicals.add(old.canonicalPath);
              receipts.push({
                skillId: old.skillId,
                agent: old.agent,
                profile: old.profile,
                project: old.project,
                revision: old.revision,
                status: "failed",
                message: error instanceof Error ? error.message : String(error),
                path: old.path,
                timestamp: new Date().toISOString(),
                localFiles: current.files,
              });
              continue;
            }
          }
          await rm(old.path, { recursive: true, force: true });
          if (old.canonicalPath) canonicalGcCandidates.add(old.canonicalPath);
          delete next.installs[key];
          receipts.push({
            skillId: old.skillId,
            agent: old.agent,
            profile: old.profile,
            project: old.project,
            revision: old.revision,
            status: "synchronized",
            message: changed
              ? "Archived and removed local files"
              : "Removed managed skill",
            path: old.path,
            timestamp: new Date().toISOString(),
          });
        } else if (action === "preserve" || action === "import") {
          if (old.canonicalPath) protectedCanonicals.add(old.canonicalPath);
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
        } else {
          if (old.canonicalPath) protectedCanonicals.add(old.canonicalPath);
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
      }
    next.generation = desired.generation;
    await saveJsonAtomic(join(home, "ledger.json"), next);
    // Different spellings can refer to the same store (e.g. /var and
    // /private/var on macOS). Protect the physical source of observed links.
    const identity = async (path: string) => realpath(path).catch(() => resolve(path));
    const referenced = new Set(await Promise.all(
      Object.values(next.installs)
        .map((entry) => entry.canonicalPath)
        .filter((path): path is string => !!path)
        .map(identity),
    ));
    const protectedSources = new Set(await Promise.all(
      [...protectedCanonicals].map(identity),
    ));
    for (const path of canonicalGcCandidates) {
      const source = await identity(path);
      if (
        !referenced.has(source) &&
        !protectedSources.has(source)
      )
        await rm(path, { recursive: true, force: true });
    }
    const retainedRoot = join(home,"retained","skills");
    for (const skillDir of await readdir(retainedRoot,{withFileTypes:true}).catch(()=>[])) if (skillDir.isDirectory())
      for (const snapshotDir of await readdir(join(retainedRoot,skillDir.name),{withFileTypes:true}).catch(()=>[])) if (snapshotDir.isDirectory()) {
        const path=join(retainedRoot,skillDir.name,snapshotDir.name);
        if (!referenced.has(await identity(path))) await rm(path,{recursive:true,force:true});
      }
    return receipts;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

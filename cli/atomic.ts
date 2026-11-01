import { randomUUID } from "node:crypto";
import { link, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

// Windows refuses to rename over a file another process has open (a status
// command, an editor, antivirus, or the indexer), reporting EPERM, EACCES, or
// EBUSY until that handle closes. Atomic JSON writes retry briefly instead of
// failing the whole operation; other platforms replace open files directly.
const transient = new Set(["EPERM", "EACCES", "EBUSY"]);

export async function renameReplacing(from: string, to: string, attempts = 20) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !transient.has(code) || attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(25 * attempt, 500)));
    }
  }
}

// An unreadable lock is held only while it may still be mid-creation by an older CLI.
const ABANDONED_LOCK_MS = 10_000;

/**
 * Takes an exclusive lock file that always contains its owner. The owner is written to a
 * private file first and hard-linked into place, so the lock appears complete or not at all;
 * a process killed mid-acquisition can no longer leave an empty lock that breaks every later
 * sync. Returns the release function, or throws `busy` while a live process holds the lock.
 */
export async function acquireLock(path: string, busy: string): Promise<() => Promise<void>> {
  const token = randomUUID();
  const staged = await stage(path, token);
  try {
    if (await claim(staged, path)) return releaser(path, token);
    if (!(await staleLock(path))) throw new Error(busy);
    // Like the locks this replaces, two processes reclaiming the same stale lock in the same
    // instant can both proceed; tn3wman/equip#28 tracks replacing this with an OS-level lock.
    await rm(path, { force: true });
    if (await claim(staged, path)) return releaser(path, token);
    throw new Error(busy);
  } finally {
    await rm(staged, { force: true });
  }
}

async function stage(path: string, token: string) {
  const staged = `${path}.${randomUUID()}.tmp`;
  await writeFile(staged, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), { mode: 0o600 });
  return staged;
}

async function claim(staged: string, path: string) {
  try {
    await link(staged, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Removes the lock only while it is still this owner's, never a successor's. */
function releaser(path: string, token: string) {
  return async () => {
    const holder = await readFile(path, "utf8").catch(() => "");
    if (holder.includes(token)) await rm(path, { force: true });
  };
}

async function staleLock(path: string) {
  const text = await readFile(path, "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return true;
  let pid: unknown;
  try { pid = (JSON.parse(text) as { pid?: unknown }).pid; } catch {}
  if (typeof pid === "number") {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }
  const info = await stat(path).catch(() => undefined);
  return !info || Date.now() - info.mtimeMs > ABANDONED_LOCK_MS;
}

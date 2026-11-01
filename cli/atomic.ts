import { rename } from "node:fs/promises";

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

const SQLITE_BUSY = 5;

/**
 * Takes an exclusive OS file lock (fcntl on macOS and Linux, LockFileEx on Windows) through
 * Node's built-in SQLite. The kernel drops the lock when its process exits, however it dies,
 * so a crashed holder never blocks the next caller and nothing ever reclaims a stale lock.
 * Returns the release function, or undefined while another holder, in any process, has it.
 */
export function tryLock(path: string): (() => void) | undefined {
  const db = new (sqlite().DatabaseSync)(path, { timeout: 0 });
  try {
    db.exec("PRAGMA journal_mode=OFF; BEGIN EXCLUSIVE");
    return () => db.close();
  } catch (error) {
    db.close();
    if (((error as { errcode?: number }).errcode ?? 0) % 256 === SQLITE_BUSY) return undefined;
    throw error;
  }
}

export function acquireLock(path: string, busy: string) {
  const release = tryLock(path);
  if (!release) throw new Error(busy);
  return release;
}

// Loading node:sqlite prints an ExperimentalWarning on every CLI run; this use is stable.
function sqlite() {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (!String(warning).startsWith("SQLite is an experimental feature"))
      (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return process.getBuiltinModule("node:sqlite");
  } finally {
    process.emitWarning = emit;
  }
}

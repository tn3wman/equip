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

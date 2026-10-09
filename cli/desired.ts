import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesiredState } from "../shared/types.ts";
import { renameReplacing } from "./atomic.ts";

/** Cache is private to one connection. Unchanged polls never download skill files. */
export async function getDesired(home: string, server: string, token: string) {
  const path = join(home, "desired-cache.json");
  const identity = createHash("sha256").update(`${server}\0${token}`).digest("hex");
  const cached = await readFile(path, "utf8").then(value => JSON.parse(value) as { identity: string; etag?: string; desired: DesiredState }).catch(error => { if (error.code === "ENOENT" || error instanceof SyntaxError) return undefined; throw error; });
  const response = await fetch(`${server}/api/device/desired`, {
    headers: { authorization: `Bearer ${token}`, ...(cached?.identity === identity && cached.etag ? { "if-none-match": cached.etag } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 304 && cached?.identity === identity) return cached.desired;
  if (!response.ok) throw new Error(`Desired configuration HTTP ${response.status}`);
  const desired = await response.json() as DesiredState;
  await mkdir(home, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ identity, etag: response.headers.get("etag"), desired }), { mode: 0o600 });
  await renameReplacing(temporary, path);
  return desired;
}

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Receipt } from "../shared/types.ts";

export interface ReceiptBatch {
  deviceId?: string;
  generation: number;
  receipts: Receipt[];
}

export async function flushReceiptOutbox(
  path: string,
  deviceId: string | undefined,
  send: (batch: ReceiptBatch) => Promise<void>,
) {
  const batch = JSON.parse(
    await readFile(path, "utf8").catch(() => "null"),
  ) as ReceiptBatch | null;
  if (!batch) return;
  if (batch.deviceId !== deviceId)
    throw new Error("Pending receipts belong to a different device");
  await send(batch);
  await rm(path, { force: true });
}

export async function queueReceiptBatch(path: string, batch: ReceiptBatch) {
  await mkdir(dirname(path), { recursive: true });
  const stage = `${path}.${process.pid}.tmp`;
  await writeFile(stage, JSON.stringify(batch), { mode: 0o600 });
  await rename(stage, path);
}

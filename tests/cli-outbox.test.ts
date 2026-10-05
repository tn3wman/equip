import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { flushReceiptOutbox, queueReceiptBatch } from "../cli/outbox.ts";

test("failed receipt delivery remains durable and is replayed on the next sync", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-outbox-"));
  const path = join(root, "receipts.json");
  const receipt = {
    skillId: "skill",
    agent: "codex",
    revision: "r1",
    status: "synchronized" as const,
    timestamp: new Date().toISOString(),
  };
  await queueReceiptBatch(path, {
    deviceId: "device",
    generation: 2,
    receipts: [receipt],
  });
  await assert.rejects(
    flushReceiptOutbox(path, "device", async () => {
      throw new Error("500");
    }),
    /500/,
  );
  assert.ok(await readFile(path));
  let delivered = 0;
  await flushReceiptOutbox(path, "device", async (batch) => {
    delivered++;
    assert.deepEqual(batch.receipts, [receipt]);
  });
  assert.equal(delivered, 1);
  await assert.rejects(readFile(path));
});

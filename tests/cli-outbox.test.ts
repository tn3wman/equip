import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { flushReceiptOutbox, queueReceiptBatch, receiptBatchFingerprint } from "../cli/outbox.ts";

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

test("receipt fingerprints ignore timestamps but include connection and desired actions", () => {
  const receipt = {
    skillId: "skill",
    agent: "codex",
    revision: "r1",
    status: "synchronized" as const,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
  const desired = { generation: 2, skills: [], resolutions: {} };
  const first = receiptBatchFingerprint("connection-a", desired, [receipt]);
  assert.equal(first, receiptBatchFingerprint("connection-a", desired, [{
    ...receipt,
    timestamp: "2026-01-02T00:00:00.000Z",
  }]));
  assert.notEqual(first, receiptBatchFingerprint("connection-b", desired, [receipt]));
  assert.notEqual(first, receiptBatchFingerprint("connection-a", {
    ...desired,
    resolutions: { skill: "replace" },
  }, [receipt]));
});

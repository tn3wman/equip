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

test("atomic JSON writes retry while Windows holds the destination open", async (t) => {
  const fs = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const { renameReplacing } = await import("../cli/atomic.ts");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  t.after(() => { Object.defineProperty(process, "platform", platform); syncBuiltinESMExports(); });
  const sharingViolation = (code: string) => Object.assign(new Error(code), { code });
  let calls = 0;
  let failures = 0;
  t.mock.method(fs.promises, "rename", async () => {
    calls++;
    if (failures-- > 0) throw sharingViolation("EPERM");
  });
  syncBuiltinESMExports();
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  failures = 2;
  await renameReplacing("state.json.tmp", "state.json");
  assert.equal(calls, 3, "two sharing violations, then the replacement lands");

  calls = 0;
  failures = Infinity;
  await assert.rejects(renameReplacing("a", "b", 4), /EPERM/);
  assert.equal(calls, 4, "a handle that never closes still fails");

  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  calls = 0;
  failures = 1;
  await assert.rejects(renameReplacing("a", "b"), /EPERM/);
  assert.equal(calls, 1, "other platforms fail immediately");
});

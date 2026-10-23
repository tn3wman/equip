import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createApp } from "../server/app.ts";

test("scheduled automatic updates contain cleanup failures, retry, and stop on close", async t => {
  // Reject network access before constructing the app, even with hosted settings inherited.
  t.mock.method(Socket.prototype, "connect", () => {
    throw new Error("Unexpected network access in offline scheduler test.");
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected fetch in offline scheduler test.");
  });
  t.mock.timers.enable({ apis: ["setInterval"] });
  const log = t.mock.method(console, "error", () => {});
  const dataDir = await mkdtemp(join(tmpdir(), "equip-auto-update-scheduler-"));
  const instance = await createApp({
    dataDir,
    databaseUrl: "",
    emailAuthEnabled: false,
    autoUpdateIntervalMs: 1_000,
  });
  const { db, close, runAutoUpdates } = instance;
  let closed = false;
  try {
    await db.run("INSERT INTO auth_rate_limits(key,count,expires_at) VALUES(?,?,?)", "expired", 1, 0);
    const run = db.run.bind(db);
    let cleanupAttempts = 0;
    t.mock.method(db, "run", async (sql: string, ...values: unknown[]) => {
      if (sql === "DELETE FROM auth_rate_limits WHERE expires_at<=?") {
        cleanupAttempts++;
        if (cleanupAttempts === 1)
          throw new Error("timeout exceeded when trying to connect: postgres://fixture:private@db.invalid/equip");
      }
      return run(sql, ...values);
    });
    const all = t.mock.method(db, "all");
    const accountScans = () => all.mock.calls.filter(call =>
      call.arguments[0] === "SELECT id FROM accounts WHERE auto_updates=1").length;

    // Exercise the actual fire-and-forget interval callback. The test runner also
    // fails on any unhandled rejection after the event loop has drained.
    t.mock.timers.tick(1_000);
    await setImmediate();
    assert.equal(cleanupAttempts, 1);
    assert.equal(accountScans(), 0);
    assert.ok(await db.get("SELECT key FROM auth_rate_limits WHERE key=?", "expired"));
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [
      ["Automatic update tick failed. Will retry on the next scheduled tick."],
    ]);

    t.mock.timers.tick(1_000);
    await setImmediate();
    assert.equal(cleanupAttempts, 2);
    assert.equal(accountScans(), 1);
    assert.equal(await db.get("SELECT key FROM auth_rate_limits WHERE key=?", "expired"), undefined);
    assert.equal(log.mock.callCount(), 1);

    await close();
    closed = true;
    t.mock.timers.tick(3_000);
    await runAutoUpdates();
    await setImmediate();
    assert.equal(cleanupAttempts, 2, "close must prevent new ticks from accessing the closed store");
    assert.equal(accountScans(), 1);
    assert.equal(log.mock.callCount(), 1);
  } finally {
    if (!closed) await close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrateLegacySqlite, openStore } from "../server/storage.ts";

test("legacy migration is one-time and never overwrites hosted records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "equip-storage-"));
  const legacyDir = path.join(root, "legacy");
  const hostedDir = path.join(root, "hosted");
  const legacy = await openStore({ dataDir: legacyDir });
  assert.equal(legacy.dialect, "sqlite");
  await legacy.run(
    "INSERT INTO accounts VALUES(?,?,?,?,?,?)",
    "legacy-account",
    "Legacy",
    "same@example.com",
    "legacy-hash",
    "{}",
    "legacy-created",
  );
  await legacy.run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    "legacy-session",
    "legacy-account",
    0,
    123,
  );
  await legacy.close();

  const hosted = await openStore({ dataDir: hostedDir });
  await hosted.run(
    "INSERT INTO accounts VALUES(?,?,?,?,?,?)",
    "hosted-account",
    "Hosted",
    "same@example.com",
    "hosted-hash",
    "{}",
    "hosted-created",
  );
  await migrateLegacySqlite(hosted, path.join(legacyDir, "equip.sqlite"));
  await migrateLegacySqlite(hosted, path.join(legacyDir, "equip.sqlite"));

  assert.deepEqual(
    await hosted.all<{ id: string; password_hash: string }>(
      "SELECT id,password_hash FROM accounts",
    ),
    [{ id: "hosted-account", password_hash: "hosted-hash" }],
  );
  assert.deepEqual(await hosted.all("SELECT * FROM sessions"), []);
  assert.equal(
    (
      await hosted.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM storage_migrations",
      )
    )!.count,
    1,
  );
  await hosted.close();
  await rm(root, { recursive: true, force: true });
});

test("storage transactions roll back all writes on failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "equip-storage-"));
  const store = await openStore({ dataDir: root });
  await assert.rejects(
    store.transaction(async (transaction) => {
      await transaction.run(
        "INSERT INTO accounts VALUES(?,?,?,?,?,?)",
        "rolled-back",
        "Rollback",
        "rollback@example.com",
        "hash",
        "{}",
        "created",
      );
      throw new Error("stop");
    }),
    /stop/,
  );
  assert.equal(await store.get("SELECT id FROM accounts WHERE id=?", "rolled-back"), undefined);
  await store.close();
  await rm(root, { recursive: true, force: true });
});

test("SQLite serializes unrelated work behind an active transaction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "equip-storage-"));
  const store = await openStore({ dataDir: root });
  let release!: () => void;
  let transactionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    transactionStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transaction = store.transaction(async (connection) => {
    await connection.run(
      "INSERT INTO accounts VALUES(?,?,?,?,?,?)",
      "first",
      "First",
      "first@example.com",
      "hash",
      "{}",
      "created",
    );
    transactionStarted();
    await gate;
  });
  await started;
  let unrelatedFinished = false;
  const unrelated = store
    .run(
      "INSERT INTO accounts VALUES(?,?,?,?,?,?)",
      "second",
      "Second",
      "second@example.com",
      "hash",
      "{}",
      "created",
    )
    .then(() => {
      unrelatedFinished = true;
    });
  await Promise.resolve();
  assert.equal(unrelatedFinished, false);
  release();
  await Promise.all([transaction, unrelated]);
  assert.deepEqual(
    (await store.all<{ id: string }>("SELECT id FROM accounts ORDER BY id")).map(
      (row) => row.id,
    ),
    ["first", "second"],
  );
  await store.close();
  await rm(root, { recursive: true, force: true });
});

test("account email uniqueness is case-insensitive", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "equip-storage-"));
  const store = await openStore({ dataDir: root });
  const account = ["Name", "hash", "{}", "created"];
  await store.run(
    "INSERT INTO accounts VALUES(?,?,?,?,?,?)",
    "first",
    account[0],
    "Owner@Example.com",
    ...account.slice(1),
  );
  await assert.rejects(
    store.run(
      "INSERT INTO accounts VALUES(?,?,?,?,?,?)",
      "second",
      account[0],
      "owner@example.com",
      ...account.slice(1),
    ),
  );
  await store.close();
  await rm(root, { recursive: true, force: true });
});

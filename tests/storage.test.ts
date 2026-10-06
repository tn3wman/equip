import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  backfillDisconnectedDevices,
  migrateLegacySqlite,
  openStore,
} from "../server/storage.ts";

test("opening an existing database adds version and compact device columns idempotently", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "equip-storage-upgrade-"));
  const database = new Database(path.join(root, "equip.sqlite"));
  database.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, workspace TEXT NOT NULL, created_at TEXT NOT NULL)");
  database.exec("CREATE TABLE workspace_devices (account_id TEXT NOT NULL, device_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account_id,device_id))");
  database.prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)").run("owner", "Owner", "owner@example.test", "hash", JSON.stringify({ skills: [{ kind: "third-party", autoUpdate: true }] }), "created");
  database.prepare("INSERT INTO workspace_devices VALUES(?,?,?)").run("owner", "device", JSON.stringify({ lastSeen: "2026-01-02T03:04:05.000Z", disconnectedAt: "2026-01-03T03:04:05.000Z" }));
  database.close();

  const first = await openStore({ dataDir: root });
  assert.equal((await first.get<{ auto_updates: number }>("SELECT auto_updates FROM accounts WHERE id=?", "owner"))!.auto_updates, 1);
  assert.deepEqual(
    await first.get("SELECT last_seen,disconnected FROM workspace_devices WHERE account_id=? AND device_id=?", "owner", "device"),
    { last_seen: "2026-01-02T03:04:05.000Z", disconnected: 1 },
  );
  // A normal restart must not rescan blobs or repair values after the one-time schema upgrade.
  await first.run("UPDATE accounts SET auto_updates=0 WHERE id=?", "owner");
  await first.run("UPDATE workspace_devices SET last_seen=?,disconnected=0 WHERE account_id=? AND device_id=?", "manual", "owner", "device");
  await first.close();
  const second = await openStore({ dataDir: root });
  assert.deepEqual(
    (await second.all<{ name: string }>("PRAGMA table_info(accounts)")).map(row => row.name),
    ["id", "name", "email", "password_hash", "workspace", "created_at", "version", "auto_updates"],
  );
  assert.equal((await second.get<{ auto_updates: number }>("SELECT auto_updates FROM accounts WHERE id=?", "owner"))!.auto_updates, 0);
  assert.deepEqual(
    await second.get("SELECT last_seen,disconnected FROM workspace_devices WHERE account_id=? AND device_id=?", "owner", "device"),
    { last_seen: "manual", disconnected: 0 },
  );
  assert.deepEqual(
    (await second.all<{ name: string }>("PRAGMA table_info(workspace_devices)")).map(row => row.name),
    ["account_id", "device_id", "payload", "version", "desired_version", "last_seen", "disconnected"],
  );
  await second.close();
  await rm(root, { recursive: true, force: true });
});

test("legacy migration is one-time and never overwrites hosted records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "equip-storage-"));
  const legacyDir = path.join(root, "legacy");
  const hostedDir = path.join(root, "hosted");
  const legacy = await openStore({ dataDir: legacyDir });
  assert.equal(legacy.dialect, "sqlite");
  await legacy.run(
    "INSERT INTO accounts(id,name,email,password_hash,workspace,created_at) VALUES(?,?,?,?,?,?)",
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
    "INSERT INTO accounts(id,name,email,password_hash,workspace,created_at) VALUES(?,?,?,?,?,?)",
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
        "INSERT INTO accounts(id,name,email,password_hash,workspace,created_at) VALUES(?,?,?,?,?,?)",
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
      "INSERT INTO accounts(id,name,email,password_hash,workspace,created_at) VALUES(?,?,?,?,?,?)",
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
      "INSERT INTO accounts(id,name,email,password_hash,workspace,created_at) VALUES(?,?,?,?,?,?)",
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
    "INSERT INTO accounts(id,name,email,password_hash,workspace,created_at) VALUES(?,?,?,?,?,?)",
    "first",
    account[0],
    "Owner@Example.com",
    ...account.slice(1),
  );
  await assert.rejects(
    store.run(
      "INSERT INTO accounts(id,name,email,password_hash,workspace,created_at) VALUES(?,?,?,?,?,?)",
      "second",
      account[0],
      "owner@example.com",
      ...account.slice(1),
    ),
  );
  await store.close();
  await rm(root, { recursive: true, force: true });
});

test("historical revoked devices receive an idempotent disconnect timestamp", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "equip-storage-"));
  const store = await openStore({ dataDir: root });
  const revokedAt = Date.UTC(2026, 9, 3, 18, 30);
  const workspace = {
    devices: [
      { id: "completed", disconnect: "retain", name: "Completed" },
      { id: "active", disconnect: "remove", name: "Active" },
      { id: "ordinary", name: "Ordinary" },
    ],
  };
  await store.run(
    "INSERT INTO accounts(id,name,email,password_hash,workspace,created_at) VALUES(?,?,?,?,?,?)",
    "account",
    "Owner",
    "owner@example.com",
    "hash",
    JSON.stringify(workspace),
    "created",
  );
  await store.run(
    "INSERT INTO device_tokens VALUES(?,?,?,?,?)",
    "completed-token",
    "account",
    "completed",
    revokedAt,
    revokedAt - 1_000,
  );
  await store.run(
    "INSERT INTO device_tokens VALUES(?,?,?,?,?)",
    "active-old-token",
    "account",
    "active",
    revokedAt,
    revokedAt - 1_000,
  );
  await store.run(
    "INSERT INTO device_tokens VALUES(?,?,?,?,?)",
    "active-token",
    "account",
    "active",
    null,
    revokedAt + 1_000,
  );
  await store.run(
    "INSERT INTO device_tokens VALUES(?,?,?,?,?)",
    "ordinary-token",
    "account",
    "ordinary",
    revokedAt,
    revokedAt - 1_000,
  );

  await backfillDisconnectedDevices(store);
  await backfillDisconnectedDevices(store);
  const saved = JSON.parse(
    (
      await store.get<{ workspace: string }>(
        "SELECT workspace FROM accounts WHERE id=?",
        "account",
      )
    )!.workspace,
  );
  assert.equal(
    saved.devices[0].disconnectedAt,
    new Date(revokedAt).toISOString(),
  );
  assert.equal(saved.devices[1].disconnectedAt, undefined);
  assert.equal(saved.devices[2].disconnectedAt, undefined);
  assert.equal(
    (await store.get<{ version: number }>("SELECT version FROM accounts WHERE id=?", "account"))!.version,
    1,
  );
  await store.close();
  await rm(root, { recursive: true, force: true });
});

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { Pool, type PoolClient } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";

export type RunResult = { changes: number };
export interface Store {
  readonly dialect: "sqlite" | "postgres";
  get<T = any>(sql: string, ...values: unknown[]): Promise<T | undefined>;
  all<T = any>(sql: string, ...values: unknown[]): Promise<T[]>;
  run(sql: string, ...values: unknown[]): Promise<RunResult>;
  transaction<T>(work: (store: Store) => Promise<T>, options?: { readOnly?: boolean }): Promise<T>;
  close(): Promise<void>;
}

const schema = [
  "CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, workspace TEXT NOT NULL, created_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, auto_updates INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account_id TEXT, demo INTEGER NOT NULL DEFAULT 0, expires_at BIGINT NOT NULL, FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE)",
  "CREATE TABLE IF NOT EXISTS device_authorizations (device_code_hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, account_id TEXT, name TEXT NOT NULL, os TEXT NOT NULL, arch TEXT NOT NULL, status TEXT NOT NULL, expires_at BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS device_tokens (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, device_id TEXT NOT NULL, revoked_at BIGINT, created_at BIGINT NOT NULL, FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE)",
  "CREATE TABLE IF NOT EXISTS auth_rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS email_authorizations (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, expires_at BIGINT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS skill_bundles (account_id TEXT NOT NULL, hash TEXT NOT NULL, files TEXT NOT NULL, PRIMARY KEY(account_id,hash), FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE)",
  "CREATE TABLE IF NOT EXISTS workspace_devices (account_id TEXT NOT NULL, device_id TEXT NOT NULL, payload TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, desired_version INTEGER NOT NULL DEFAULT 0, last_seen TEXT NOT NULL DEFAULT '', disconnected INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account_id,device_id), FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE)",
];

async function addColumn(store: Store, table: string, column: string, definition: string) {
  if (store.dialect === "postgres") {
    const existing = await store.get(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=? AND column_name=?",
      table,
      column,
    );
    if (existing) return false;
    await store.run(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
    return true;
  }
  const columns = await store.all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (columns.some(item => item.name === column)) return false;
  await store.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

class SQLiteStore implements Store {
  readonly dialect = "sqlite" as const;
  private tail = Promise.resolve();
  constructor(
    readonly database: Database.Database,
    private readonly transactionConnection = false,
  ) {}
  private async serialized<T>(work: () => T | Promise<T>) {
    if (this.transactionConnection) return work();
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
  async get<T>(sql: string, ...values: unknown[]) {
    return this.serialized(
      () => this.database.prepare(sql).get(...values) as T | undefined,
    );
  }
  async all<T>(sql: string, ...values: unknown[]) {
    return this.serialized(() => this.database.prepare(sql).all(...values) as T[]);
  }
  async run(sql: string, ...values: unknown[]) {
    return this.serialized(() => {
      const result = this.database.prepare(sql).run(...values);
      return { changes: result.changes };
    });
  }
  async transaction<T>(work: (store: Store) => Promise<T>, options: { readOnly?: boolean } = {}) {
    return this.serialized(async () => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        try { this.database.exec(options.readOnly ? "BEGIN" : "BEGIN IMMEDIATE"); break; }
        catch (error: any) {
          if (error.code !== "SQLITE_BUSY" || Date.now() >= deadline) throw error;
          // Yield so another application's asynchronous transaction can finish.
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      try {
        const result = await work(new SQLiteStore(this.database, true));
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    });
  }
  async close() {
    await this.serialized(() => this.database.close());
  }
}

function postgresSql(sql: string) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

class PostgresStore implements Store {
  readonly dialect = "postgres" as const;
  constructor(
    private readonly pool: Pool,
    private readonly client?: PoolClient,
  ) {}
  private query(sql: string, values: unknown[]) {
    return (this.client ?? this.pool).query(postgresSql(sql), values);
  }
  async get<T>(sql: string, ...values: unknown[]) {
    return (await this.query(sql, values)).rows[0] as T | undefined;
  }
  async all<T>(sql: string, ...values: unknown[]) {
    return (await this.query(sql, values)).rows as T[];
  }
  async run(sql: string, ...values: unknown[]) {
    const result = await this.query(sql, values);
    return { changes: result.rowCount ?? 0 };
  }
  async transaction<T>(work: (store: Store) => Promise<T>, options: { readOnly?: boolean } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query(options.readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
      const result = await work(new PostgresStore(this.pool, client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async close() {
    if (!this.client) await this.pool.end();
  }
}

async function initialize(store: Store) {
  for (const statement of schema)
    await store.run(store.dialect === "postgres" ? statement.replaceAll("version INTEGER", "version BIGINT") : statement);
  const versionType = store.dialect === "postgres" ? "BIGINT" : "INTEGER";
  await addColumn(store, "accounts", "version", `${versionType} NOT NULL DEFAULT 0`);
  const addedAutoUpdates = await addColumn(store, "accounts", "auto_updates", "INTEGER NOT NULL DEFAULT 0");
  await addColumn(store, "workspace_devices", "version", `${versionType} NOT NULL DEFAULT 0`);
  await addColumn(store, "workspace_devices", "desired_version", `${versionType} NOT NULL DEFAULT 0`);
  const addedLastSeen = await addColumn(store, "workspace_devices", "last_seen", "TEXT NOT NULL DEFAULT ''");
  const addedDisconnected = await addColumn(store, "workspace_devices", "disconnected", "INTEGER NOT NULL DEFAULT 0");
  await store.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_lower_unique ON accounts(LOWER(email))",
  );
  await store.run("CREATE INDEX IF NOT EXISTS accounts_auto_updates ON accounts(auto_updates)");
  await store.run("CREATE INDEX IF NOT EXISTS auth_rate_limits_expiry ON auth_rate_limits(expires_at)");
  if (store.dialect === "postgres") {
    const autoUpdates = "CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(workspace::jsonb->'skills','[]'::jsonb)) skill WHERE skill->>'kind'='third-party' AND COALESCE((skill->>'autoUpdate')::boolean,FALSE)) THEN 1 ELSE 0 END";
    if (addedAutoUpdates) await store.run(`UPDATE accounts SET auto_updates=${autoUpdates}`);
    if (addedLastSeen || addedDisconnected)
      await store.run(`UPDATE workspace_devices SET last_seen=COALESCE(payload::jsonb->>'lastSeen',''),disconnected=CASE WHEN jsonb_exists(payload::jsonb,'disconnectedAt') THEN 1 ELSE 0 END WHERE ${addedLastSeen ? "last_seen=''" : "TRUE"}`);
  } else {
    const autoUpdates = "CASE WHEN EXISTS (SELECT 1 FROM json_each(accounts.workspace,'$.skills') skill WHERE json_extract(skill.value,'$.kind')='third-party' AND json_extract(skill.value,'$.autoUpdate')=1) THEN 1 ELSE 0 END";
    if (addedAutoUpdates) await store.run(`UPDATE accounts SET auto_updates=${autoUpdates}`);
    if (addedLastSeen || addedDisconnected)
      await store.run(`UPDATE workspace_devices SET last_seen=COALESCE(json_extract(payload,'$.lastSeen'),''),disconnected=CASE WHEN json_type(payload,'$.disconnectedAt') IS NOT NULL THEN 1 ELSE 0 END WHERE ${addedLastSeen ? "last_seen=''" : "1=1"}`);
  }
  if (store.dialect === "postgres") {
    await store.run(
      "CREATE TABLE IF NOT EXISTS storage_migrations (name TEXT PRIMARY KEY, completed_at TEXT NOT NULL)",
    );
    for (const table of [
      "accounts",
      "sessions",
      "device_authorizations",
      "device_tokens",
      "storage_migrations",
      "auth_rate_limits",
      "email_authorizations",
      "skill_bundles",
      "workspace_devices",
    ])
      await store.run(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  }
}

export async function migrateLegacySqlite(store: Store, sqlitePath: string) {
  if (!fs.existsSync(sqlitePath)) return;
  await store.run(
    "CREATE TABLE IF NOT EXISTS storage_migrations (name TEXT PRIMARY KEY, completed_at TEXT NOT NULL)",
  );
  if (
    await store.get(
      "SELECT name FROM storage_migrations WHERE name=?",
      "legacy-sqlite-v1",
    )
  )
    return;
  const legacy = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    const tables = [
      ["accounts", ["id", "name", "email", "password_hash", "workspace", "created_at"], false],
      ["sessions", ["token_hash", "account_id", "demo", "expires_at"], true],
      ["device_authorizations", ["device_code_hash", "user_code", "account_id", "name", "os", "arch", "status", "expires_at"], true],
      ["device_tokens", ["token_hash", "account_id", "device_id", "revoked_at", "created_at"], true],
    ] as const;
    await store.transaction(async (transaction) => {
      for (const [table, columns, referencesAccount] of tables) {
        const rows = legacy.prepare(`SELECT ${columns.join(",")} FROM ${table}`).all() as Record<string, unknown>[];
        for (const row of rows) {
          if (
            referencesAccount &&
            row.account_id &&
            !(await transaction.get(
              "SELECT id FROM accounts WHERE id=?",
              row.account_id,
            ))
          )
            continue;
          await transaction.run(
            `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT DO NOTHING`,
            ...columns.map((column) => row[column]),
          );
        }
      }
      await transaction.run(
        "INSERT INTO storage_migrations(name,completed_at) VALUES(?,?)",
        "legacy-sqlite-v1",
        new Date().toISOString(),
      );
    });
  } finally {
    legacy.close();
  }
}

export async function backfillDisconnectedDevices(store: Store) {
  await store.transaction(async (transaction) => {
    const legacyWorkspace = transaction.dialect === "postgres"
      ? "workspace::jsonb->>'storageVersion' IS NULL AND jsonb_typeof(workspace::jsonb->'devices')='array'"
      : "json_extract(workspace,'$.storageVersion') IS NULL AND json_type(workspace,'$.devices')='array'";
    const accounts = await transaction.all<{ id: string; workspace: string }>(
      `SELECT id,workspace FROM accounts WHERE ${legacyWorkspace}`,
    );
    if (!accounts.length) return;
    const tokens = await transaction.all<{
      account_id: string;
      device_id: string;
      revoked_at: number | string | null;
    }>("SELECT account_id,device_id,revoked_at FROM device_tokens");
    const active = new Set(
      tokens
        .filter((token) => token.revoked_at === null)
        .map((token) => `${token.account_id}:${token.device_id}`),
    );
    const revoked = new Map<string, number>();
    for (const token of tokens) {
      if (token.revoked_at === null) continue;
      const key = `${token.account_id}:${token.device_id}`;
      const timestamp = Number(token.revoked_at);
      if (Number.isFinite(timestamp) && timestamp > (revoked.get(key) ?? 0))
        revoked.set(key, timestamp);
    }
    for (const account of accounts) {
      const workspace = JSON.parse(account.workspace) as {
        devices?: Array<{
          id: string;
          disconnect?: "retain" | "remove";
          disconnectedAt?: string;
        }>;
      };
      let changed = false;
      for (const device of workspace.devices ?? []) {
        const key = `${account.id}:${device.id}`;
        const timestamp = revoked.get(key);
        if (
          device.disconnect &&
          !device.disconnectedAt &&
          timestamp !== undefined &&
          !active.has(key)
        ) {
          device.disconnectedAt = new Date(timestamp).toISOString();
          changed = true;
        }
      }
      if (changed)
        await transaction.run(
          "UPDATE accounts SET workspace=?,version=version+1 WHERE id=?",
          JSON.stringify(workspace),
          account.id,
        );
    }
  });
}

export async function openStore(options: {
  dataDir: string;
  databaseUrl?: string;
  databaseCa?: string;
}): Promise<Store> {
  if (options.databaseUrl) {
    const pool = new Pool({
      connectionString: options.databaseUrl,
      max: 5,
      connectionTimeoutMillis: 10_000,
      ssl: {
        rejectUnauthorized: true,
        ...(options.databaseCa ? { ca: options.databaseCa } : {}),
      },
    });
    pool.on("error", () => {
      console.error("PostgreSQL connection pool error.");
    });
    const store = new PostgresStore(pool);
    try {
      await initialize(store);
      await migrateLegacySqlite(store, path.join(options.dataDir, "equip.sqlite"));
      await backfillDisconnectedDevices(store);
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }
  fs.mkdirSync(options.dataDir, { recursive: true });
  const database = new Database(path.join(options.dataDir, "equip.sqlite"));
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 0");
  const store = new SQLiteStore(database);
  await initialize(store);
  await backfillDisconnectedDevices(store);
  return store;
}

/** Every query inside an account operation uses the same database transaction. */
export function transactionalStore(store: Store): Store {
  const context = new AsyncLocalStorage<Store>();
  return {
    dialect: store.dialect,
    get: (sql, ...values) => (context.getStore() ?? store).get(sql, ...values),
    all: (sql, ...values) => (context.getStore() ?? store).all(sql, ...values),
    run: (sql, ...values) => (context.getStore() ?? store).run(sql, ...values),
    transaction: (work, options) => context.getStore()
      ? work(context.getStore()!)
      : store.transaction(transaction => context.run(transaction, () => work(transaction)), options),
    close: () => store.close(),
  };
}

export async function lockAccount(store: Store, accountId: string) {
  return store.get<{id: string}>(
    `SELECT id FROM accounts WHERE id=?${store.dialect === "postgres" ? " FOR UPDATE" : ""}`,
    accountId,
  );
}

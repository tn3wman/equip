import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PersistentRateLimiter, rateLimitKey } from "../server/rate-limit.ts";
import { openStore } from "../server/storage.ts";

test("authentication limits are atomic, persistent, and reset after expiry", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "equip-limiter-"));
  const key = rateLimitKey("test", "private@example.test");
  let store = await openStore({ dataDir });
  try {
    await store.run("CREATE TABLE IF NOT EXISTS auth_rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at BIGINT NOT NULL)");
    let limiter = new PersistentRateLimiter(store);
    const results = await Promise.all(Array.from({ length: 12 }, () => limiter.consume(key, 10, 60_000, 1_000)));
    assert.equal(results.filter(result => result.allowed).length, 10);
    await store.close();

    store = await openStore({ dataDir });
    limiter = new PersistentRateLimiter(store);
    assert.equal((await limiter.consume(key, 10, 60_000, 2_000)).allowed, false);
    assert.equal((await limiter.consume(key, 10, 60_000, 61_000)).allowed, true);
    const row = await store.get<{ key: string }>("SELECT key FROM auth_rate_limits WHERE key=?", key);
    assert.equal(row?.key.includes("private@example.test"), false);
  } finally {
    await store.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

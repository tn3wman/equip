import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../server/app.ts";
import { rateLimitKey } from "../server/rate-limit.ts";

async function runningApp(dataDir: string) {
  const instance = await createApp({ dataDir, autoUpdateIntervalMs: 0, emailAuthEnabled: false });
  const listener = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  return {
    ...instance,
    base,
    stop: async () => {
      await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
      await instance.close();
    },
  };
}

test("password throttles share atomic counters across app instances and restarts", { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "equip-auth-abuse-"));
  const first = await runningApp(dataDir);
  const second = await runningApp(dataDir);
  const login = (base: string) => fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "missing@example.test", password: "incorrect-password" }),
  });
  try {
    const responses = await Promise.all(
      Array.from({ length: 32 }, (_, index) => login(index % 2 ? first.base : second.base)),
    );
    assert.equal(responses.filter(response => response.status === 401).length, 15);
    assert.equal(responses.filter(response => response.status === 429).length, 17);
    assert.ok(responses.filter(response => response.status === 429).every(response => Number(response.headers.get("retry-after")) > 0));
    const row = await first.db.get<{ count: number | string }>(
      "SELECT count FROM auth_rate_limits WHERE key=?",
      rateLimitKey("password-login", "127.0.0.1"),
    );
    assert.equal(Number(row?.count), 32);
    const emailRow = await first.db.get<{ count: number | string }>(
      "SELECT count FROM auth_rate_limits WHERE key=?",
      rateLimitKey("password-login-email", "missing@example.test"),
    );
    assert.equal(Number(emailRow?.count), 30);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }

  const restarted = await runningApp(dataDir);
  try {
    const response = await login(restarted.base);
    assert.equal(response.status, 429);
    const row = await restarted.db.get<{ count: number | string }>(
      "SELECT count FROM auth_rate_limits WHERE key=?",
      rateLimitKey("password-login", "127.0.0.1"),
    );
    assert.equal(Number(row?.count), 33);
  } finally {
    await restarted.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

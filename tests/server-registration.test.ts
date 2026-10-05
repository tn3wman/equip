import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../server/app.ts";

async function withServer(
  registrationEmail: string | undefined,
  run: (base: string, accountCount: () => Promise<number>) => Promise<void>,
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "equip-registration-"));
  const { app, db, close } = await createApp({
    dataDir,
    autoUpdateIntervalMs: 0,
    registrationEmail,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base, async () =>
      Number(
        (await db.get<any>("SELECT COUNT(*) AS count FROM accounts"))!.count,
      ),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const register = (base: string, email: string) =>
  fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Preview user",
      email,
      password: "correct horse battery",
    }),
  });

test("registration allowlist rejects other accounts before creating them", async () => {
  await withServer(" invited@example.com ", async (base, accountCount) => {
    const rejected = await register(base, "someone-else@example.com");
    assert.equal(rejected.status, 403);
    assert.deepEqual(await rejected.json(), {
      error: "This preview is limited to invited accounts.",
    });
    assert.equal(await accountCount(), 0);

    const accepted = await register(base, "  INVITED@EXAMPLE.COM ");
    assert.equal(accepted.status, 201);
    assert.equal(await accountCount(), 1);
  });
});

test("registration remains open when no allowlist is configured", async () => {
  await withServer(undefined, async (base, accountCount) => {
    const response = await register(base, "open@example.com");
    assert.equal(response.status, 201);
    assert.equal(await accountCount(), 1);
  });
});

test("password endpoints are disabled when email authentication is enabled", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "equip-email-auth-"));
  const { app, close } = await createApp({
    dataDir,
    autoUpdateIntervalMs: 0,
    emailAuthEnabled: true,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const route of ["register", "login"]) {
      const response = await fetch(`${base}/api/auth/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Blocked",
          email: "blocked@example.com",
          password: "correct horse battery",
        }),
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), {
        error: "Use your email sign-in link to continue.",
      });
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

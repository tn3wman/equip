import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../server/app.ts";

async function withServer(
  registrationEmail: string | undefined,
  run: (base: string, accountCount: () => number) => Promise<void>,
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "equip-registration-"));
  const { app, db, close } = createApp({
    dataDir,
    autoUpdateIntervalMs: 0,
    registrationEmail,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base, () =>
      Number(
        (db.prepare("SELECT COUNT(*) AS count FROM accounts").get() as any)
          .count,
      ),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    close();
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
    assert.equal(accountCount(), 0);

    const accepted = await register(base, "  INVITED@EXAMPLE.COM ");
    assert.equal(accepted.status, 201);
    assert.equal(accountCount(), 1);
  });
});

test("registration remains open when no allowlist is configured", async () => {
  await withServer(undefined, async (base, accountCount) => {
    const response = await register(base, "open@example.com");
    assert.equal(response.status, 201);
    assert.equal(accountCount(), 1);
  });
});

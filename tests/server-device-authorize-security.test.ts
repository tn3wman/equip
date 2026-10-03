import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../server/app.ts";

test("device authorization bounds unauthenticated database writes", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "equip-device-auth-"));
  const { app, db, close } = await createApp({
    dataDir,
    autoUpdateIntervalMs: 0,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const authorize = (body: unknown) =>
    fetch(`${base}/api/device/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const oversized = await authorize({
      name: "x".repeat(121),
      os: "linux",
      arch: "x64",
    });
    assert.equal(oversized.status, 400);
    assert.equal(
      (
        await db.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM device_authorizations",
        )
      )!.count,
      0,
    );

    for (let index = 0; index < 30; index++)
      assert.equal(
        (await authorize({ name: `Device ${index}`, os: "linux", arch: "x64" }))
          .status,
        201,
      );
    const limited = await authorize({ name: "Device 31", os: "linux", arch: "x64" });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), {
      error: "Too many device authorization requests. Try again shortly.",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

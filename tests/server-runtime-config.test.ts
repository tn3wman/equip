import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../server/app.ts";
import {
  configuredPublicUrl,
  runtimeConfig,
} from "../server/config.ts";

test("Railway runtime defaults to its listener, volume, and public origin", () => {
  const config = runtimeConfig({
    RAILWAY_ENVIRONMENT_ID: "preview",
    RAILWAY_VOLUME_MOUNT_PATH: "/data",
    RAILWAY_PUBLIC_DOMAIN: "equip-preview.example",
  });
  assert.deepEqual(config, {
    host: "0.0.0.0",
    port: 4310,
    dataDir: "/data",
  });
  assert.equal(
    configuredPublicUrl(undefined, {
      RAILWAY_PUBLIC_DOMAIN: "equip-preview.example",
    }),
    "https://equip-preview.example",
  );
});

test("explicit local runtime settings override hosted defaults", () => {
  const config = runtimeConfig({
    RAILWAY_ENVIRONMENT_ID: "preview",
    RAILWAY_VOLUME_MOUNT_PATH: "/data",
    HOST: "127.0.0.2",
    PORT: "8080",
    EQUIP_DATA_DIR: "/tmp/equip",
  });
  assert.deepEqual(config, {
    host: "127.0.0.2",
    port: 8080,
    dataDir: "/tmp/equip",
  });
  assert.equal(runtimeConfig({}).host, "127.0.0.1");
});

test("health reports database readiness without authentication", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "equip-health-"));
  const { app, db } = createApp({ dataDir, autoUpdateIntervalMs: 0 });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    db.close();
    const unavailable = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { status: "unavailable" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (db.open) db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

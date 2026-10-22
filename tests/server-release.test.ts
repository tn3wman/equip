import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyReleaseManifest } from "../cli/update.ts";
import { createApp } from "../server/app.ts";

const releaseEnvironment = ["NODE_ENV", "EQUIP_RELEASE_PRIVATE_KEY", "EQUIP_RELEASE_PRIVATE_KEY_V2"] as const;

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

test("each CLI manifest route signs with its own key and v2 fails closed without its key", async t => {
  const root = await mkdtemp(join(tmpdir(), "equip-server-release-"));
  const saved = Object.fromEntries(releaseEnvironment.map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const name of releaseEnvironment) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await rm(root, { recursive: true, force: true });
  });
  // Answer the npm registry integrity lookup locally; everything else is real HTTP.
  const integrity = `sha512-${Buffer.alloc(64, 3).toString("base64")}`;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    String(input).startsWith("https://registry.npmjs.org/")
      ? Response.json({ dist: { integrity } })
      : originalFetch(input, init)) as typeof fetch;

  const cliArtifact = join(root, "equip.cjs");
  await writeFile(cliArtifact, "release bundle");
  const { app, close } = await createApp({
    dataDir: join(root, "data"),
    autoUpdateIntervalMs: 0,
    publicUrl: "https://equip.example",
    cliArtifact,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => listener.close(error => (error ? reject(error) : resolve())));
    await close();
  });
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const manifest = async (route: string) => {
    const response = await fetch(`${base}${route}`);
    return { status: response.status, body: await response.json() };
  };

  const legacy = keyPair();
  const v2 = keyPair();
  process.env.NODE_ENV = "production";
  process.env.EQUIP_RELEASE_PRIVATE_KEY = legacy.privateKey;
  delete process.env.EQUIP_RELEASE_PRIVATE_KEY_V2;

  const unconfigured = await manifest("/cli/manifest/v2");
  assert.equal(unconfigured.status, 500);
  assert.deepEqual(unconfigured.body, { error: "Internal server error." });
  const legacyOnly = await manifest("/cli/manifest");
  assert.equal(legacyOnly.status, 200, "a missing v2 key must not affect the legacy route");
  verifyReleaseManifest(legacyOnly.body, "https://equip.example", [legacy.publicKey]);

  process.env.EQUIP_RELEASE_PRIVATE_KEY_V2 = v2.privateKey;
  const current = await manifest("/cli/manifest/v2");
  assert.equal(current.status, 200);
  assert.equal(current.body.origin, "https://equip.example");
  verifyReleaseManifest(current.body, "https://equip.example", [v2.publicKey]);
  assert.throws(() => verifyReleaseManifest(current.body, "https://equip.example", [legacy.publicKey]), /signature/);
  const legacyRoute = await manifest("/cli/manifest");
  verifyReleaseManifest(legacyRoute.body, "https://equip.example", [legacy.publicKey]);
  assert.throws(() => verifyReleaseManifest(legacyRoute.body, "https://equip.example", [v2.publicKey]), /signature/);

  delete process.env.EQUIP_RELEASE_PRIVATE_KEY;
  assert.equal((await manifest("/cli/manifest")).status, 500);
  assert.equal((await manifest("/cli/manifest/v2")).status, 200, "a missing legacy key must not affect v2");
});

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyReleaseManifest } from "../cli/update.ts";
import { createApp } from "../server/app.ts";

const releaseEnvironment = ["NODE_ENV", "EQUIP_RELEASE_PRIVATE_KEY_V2"] as const;

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

test("the CLI manifest is signed with the v2 key, fails closed without it, and the legacy route is gone", async t => {
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
  // A built dashboard enables the HTML fallback, so the 404 checks below prove /cli paths bypass it.
  const publicDir = join(root, "dist");
  await mkdir(publicDir);
  await writeFile(join(publicDir, "index.html"), "<!doctype html><title>dashboard</title>");
  const { app, close } = await createApp({
    dataDir: join(root, "data"),
    autoUpdateIntervalMs: 0,
    publicUrl: "https://equip.example",
    cliArtifact,
    publicDir,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => listener.close(error => (error ? reject(error) : resolve())));
    await close();
  });
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const manifest = async () => {
    const response = await fetch(`${base}/cli/manifest/v2`);
    return { status: response.status, body: await response.json() };
  };

  const v2 = keyPair();
  process.env.NODE_ENV = "production";
  delete process.env.EQUIP_RELEASE_PRIVATE_KEY_V2;

  const unconfigured = await manifest();
  assert.equal(unconfigured.status, 500);
  assert.deepEqual(unconfigured.body, { error: "Internal server error." });

  process.env.EQUIP_RELEASE_PRIVATE_KEY_V2 = v2.privateKey;
  const current = await manifest();
  assert.equal(current.status, 200);
  assert.equal(current.body.origin, "https://equip.example");
  verifyReleaseManifest(current.body, "https://equip.example", [v2.publicKey]);
  assert.throws(() => verifyReleaseManifest(current.body, "https://equip.example", [keyPair().publicKey]), /signature/);

  // The retired route signed with the leaked pre-rotation key must not serve a manifest,
  // and the dashboard fallback must not answer it or any other unmatched /cli path.
  assert.equal((await fetch(`${base}/settings`)).status, 200);
  assert.equal((await fetch(`${base}/cli/manifest`)).status, 404);
  assert.equal((await fetch(`${base}/cli/unknown`)).status, 404);
});

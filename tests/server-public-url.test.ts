import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../server/app.ts";

test("public HTTPS origin drives authorization, installers, and secure cookies", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "equip-public-url-"));
  const { app, close } = await createApp({
    dataDir,
    autoUpdateIntervalMs: 0,
    publicUrl: "https://equip.example.test",
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const registration = await fetch(`${local}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Public",
        email: "public@example.test",
        password: "correct horse battery",
      }),
    });
    assert.match(
      registration.headers.get("set-cookie") ?? "",
      /; Secure(?:;|$)/i,
    );
    const authorization = await fetch(`${local}/api/device/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Hosted device", os: "linux", arch: "x64" }),
    }).then((response) => response.json());
    assert.match(
      authorization.verificationUri,
      /^https:\/\/equip\.example\.test\/connect\?code=/,
    );
    const installer = await fetch(`${local}/install.sh`).then((response) =>
      response.text(),
    );
    assert.match(installer, /https:\/\/equip\.example\.test\/cli\/manifest/);
    assert.doesNotMatch(installer, /127\.0\.0\.1/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("public URL rejects non-origin and non-HTTP values", async () => {
  await assert.rejects(
    async () => await createApp({ publicUrl: "https://equip.example.test/path" }),
    /must be an HTTP\(S\) origin/,
  );
  await assert.rejects(
    async () => await createApp({ publicUrl: "javascript:alert(1)" }),
    /must be an HTTP\(S\) origin/,
  );
});

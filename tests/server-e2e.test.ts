import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.ts";
import { synchronize } from "../cli/sync.ts";

test("two devices install independently and removal preserves only the edited copy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "equip-api-e2e-"));
  const { app, close } = createApp({
    dataDir: path.join(root, "data"),
    autoUpdateIntervalMs: 0,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = "";
  const request = async (
    route: string,
    init: RequestInit = {},
    bearer?: string,
  ) => {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    if (cookie) headers.set("cookie", cookie);
    if (bearer) headers.set("authorization", `Bearer ${bearer}`);
    const response = await fetch(`${base}${route}`, { ...init, headers });
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    return { response, body: await response.json() };
  };
  const post = (route: string, body: unknown, bearer?: string) =>
    request(route, { method: "POST", body: JSON.stringify(body) }, bearer);
  try {
    await post("/api/auth/register", {
      name: "E2E",
      email: "e2e@example.com",
      password: "correct horse battery",
    });
    const files = [
      {
        path: "SKILL.md",
        content:
          "---\nname: shared-e2e\ndescription: Cross-device test skill\n---\n\n# Shared\n",
      },
      {
        path: "scripts/run.sh",
        content: "#!/bin/sh\necho ready\n",
        mode: 0o755,
      },
    ];
    const draft = await post("/api/skills", {
      title: "Shared E2E",
      name: "shared-e2e",
      description: "Cross-device",
      files,
    });
    const published = await post(`/api/skills/${draft.body.id}/publish`, {
      message: "Initial release",
    });
    const devices: Array<{
      token: string;
      id: string;
      target: string;
      home: string;
    }> = [];
    for (const label of ["one", "two"]) {
      const authorization = await post("/api/device/authorize", {
        name: `Device ${label}`,
        os: "linux",
        arch: "x64",
      });
      await post("/api/device/approve", {
        userCode: authorization.body.userCode,
      });
      const connected = await post("/api/device/token", {
        deviceCode: authorization.body.deviceCode,
      });
      const target = path.join(root, label, "skills");
      const home = path.join(root, label, "equip");
      await post(
        "/api/device/heartbeat",
        {
          name: `Device ${label}`,
          os: "linux",
          arch: "x64",
          agents: [{ id: "codex", name: "Codex", path: target }],
        },
        connected.body.token,
      );
      devices.push({
        token: connected.body.token,
        id: connected.body.deviceId,
        target,
        home,
      });
    }
    for (const device of devices) {
      const desired = await request("/api/device/desired", {}, device.token);
      const receipts = await synchronize(
        desired.body,
        [{ id: "codex", path: device.target, deviceId: device.id }],
        device.home,
      );
      await post(
        "/api/device/receipts",
        { generation: desired.body.generation, receipts },
        device.token,
      );
      assert.match(
        await readFile(
          path.join(device.target, "shared-e2e", "SKILL.md"),
          "utf8",
        ),
        /# Shared/,
      );
    }
    await writeFile(
      path.join(devices[0].target, "shared-e2e", "SKILL.md"),
      `${files[0].content}\nLocal edit\n`,
    );
    await request(`/api/skills/${published.body.id}`, { method: "DELETE" });
    const removalReceipts = [];
    for (const device of devices) {
      const desired = await request("/api/device/desired", {}, device.token);
      const receipts = await synchronize(
        desired.body,
        [{ id: "codex", path: device.target, deviceId: device.id }],
        device.home,
      );
      removalReceipts.push(receipts);
      await post(
        "/api/device/receipts",
        { generation: desired.body.generation, receipts },
        device.token,
      );
    }
    assert.equal(removalReceipts[0][0].status, "conflicted");
    assert.ok(
      removalReceipts[0][0].localFiles?.some(
        (file) => file.path === "SKILL.md",
      ),
    );
    assert.match(
      await readFile(
        path.join(devices[0].target, "shared-e2e", "SKILL.md"),
        "utf8",
      ),
      /Local edit/,
    );
    await assert.rejects(
      readFile(path.join(devices[1].target, "shared-e2e", "SKILL.md")),
    );
    const workspace = await request("/api/workspace");
    const removedDevice = workspace.body.devices.find(
      (device: any) => device.id === devices[1].id,
    );
    assert.ok(removedDevice.lastSync);
    assert.equal(removedDevice.appliedGeneration, workspace.body.generation);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    close();
    await rm(root, { recursive: true, force: true });
  }
});

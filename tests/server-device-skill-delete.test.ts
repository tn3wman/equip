import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../server/app.ts";

test("a device retires an account skill with an exact revision and every paired device receives the removal generation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "equip-device-delete-"));
  const instance = await createApp({ dataDir: root, autoUpdateIntervalMs: 0 });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await instance.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (route: string, init: RequestInit = {}, cookie?: string) => {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(`${base}${route}`, { ...init, headers });
    return {
      response,
      body: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  };
  const post = (route: string, body: unknown, cookie?: string, headers?: HeadersInit) =>
    request(route, { method: "POST", headers, body: JSON.stringify(body) }, cookie);
  const registered = await post("/api/auth/register", {
    name: "Device deletion",
    email: "device-delete@example.com",
    password: "correct horse battery",
  });
  const cookie = registered.cookie!;
  const connect = async (name: string) => {
    const authorization = await post("/api/device/authorize", { name, os: "linux", arch: "x64" });
    await post("/api/device/approve", { userCode: authorization.body.userCode }, cookie);
    const connected = await post("/api/device/token", { deviceCode: authorization.body.deviceCode });
    return {
      id: connected.body.deviceId as string,
      token: connected.body.token as string,
      headers: { authorization: `Bearer ${connected.body.token}` },
    };
  };
  const requestingDevice = await connect("Requesting Mac");
  const pairedDevice = await connect("Paired Linux");
  const files = [{
    path: "SKILL.md",
    content: "---\nname: retire-me\ndescription: Device deletion fixture\n---\n\n# Retire me\n",
  }];
  const draft = await post("/api/skills", {
    name: "retire-me", title: "Retire me", description: "fixture", files,
  }, cookie);
  const published = await post(`/api/skills/${draft.body.id}/publish`, {}, cookie);

  const missingPrecondition = await request(`/api/device/skills/${published.body.id}`, {
    method: "DELETE", headers: requestingDevice.headers, body: JSON.stringify({}),
  });
  assert.equal(missingPrecondition.response.status, 409);
  const stale = await request(`/api/device/skills/${published.body.id}`, {
    method: "DELETE", headers: requestingDevice.headers,
    body: JSON.stringify({ expectedRevision: "stale" }),
  });
  assert.equal(stale.response.status, 409);
  assert.ok((await request("/api/workspace", {}, cookie)).body.skills.some((skill: any) => skill.id === published.body.id));

  const removed = await request(`/api/device/skills/${published.body.id}`, {
    method: "DELETE", headers: requestingDevice.headers,
    body: JSON.stringify({ expectedRevision: published.body.revision }),
  });
  assert.equal(removed.response.status, 200);
  assert.deepEqual(removed.body, {
    ok: true,
    id: published.body.id,
    name: "retire-me",
    generation: removed.body.generation,
  });
  const desired = await request("/api/device/desired", { headers: pairedDevice.headers });
  assert.equal(desired.body.generation, removed.body.generation);
  assert.ok(!desired.body.skills.some((skill: any) => skill.id === published.body.id));
  assert.deepEqual(desired.body.retiredSkills, [{
    id: published.body.id,
    name: "retire-me",
    revision: published.body.revision,
  }]);
  const workspace = (await request("/api/workspace", {}, cookie)).body;
  assert.ok(!workspace.skills.some((skill: any) => skill.id === published.body.id));
  const retired = workspace.retiredSkills.find((skill: any) => skill.id === published.body.id);
  assert.equal(retired.selected, false);
  assert.equal(retired.enabled, false);
  assert.equal(workspace.activity[0].deviceId, requestingDevice.id);
  assert.equal(workspace.activity[0].skillId, published.body.id);

  const automatic = await post("/api/device/local", {
    name: "retire-me", sourcePath: "/skills/retire-me", files,
  }, undefined, requestingDevice.headers);
  assert.equal(automatic.response.status, 403);
  await request(`/api/devices/${requestingDevice.id}/local-sync`, {
    method: "PATCH", body: JSON.stringify({ enabled: true }),
  }, cookie);
  const automaticEnabled = await post("/api/device/local", {
    name: "retire-me", sourcePath: "/skills/retire-me", files,
  }, undefined, requestingDevice.headers);
  assert.equal(automaticEnabled.response.status, 409);
  const deliberate = await post("/api/device/local", {
    explicit: true, name: "retire-me", sourcePath: "/skills/retire-me", files,
  }, undefined, requestingDevice.headers);
  assert.equal(deliberate.response.status, 200);
  const editedFiles = [{ ...files[0], content: `${files[0].content}\nChanged after re-adding.\n` }];
  const automaticUpdate = await post("/api/device/local", {
    name: "retire-me", sourcePath: "/skills/retire-me", files: editedFiles,
    baseRevision: deliberate.body.revision,
  }, undefined, requestingDevice.headers);
  assert.equal(automaticUpdate.response.status, 200);
  const afterReadd = (await request("/api/workspace", {}, cookie)).body;
  assert.ok(afterReadd.skills.some((skill: any) => skill.id === deliberate.body.id));
  assert.ok(afterReadd.retiredSkills.some((skill: any) => skill.id === published.body.id));
});

test("device skill deletion stays token-, device-, and account-scoped while account deletion retains retirement behavior", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "equip-device-delete-auth-"));
  const instance = await createApp({ dataDir: root, autoUpdateIntervalMs: 0 });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await instance.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (route: string, init: RequestInit = {}, cookie?: string) => {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(`${base}${route}`, { ...init, headers });
    return { response, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const post = (route: string, body: unknown, cookie?: string) =>
    request(route, { method: "POST", body: JSON.stringify(body) }, cookie);
  const register = async (email: string) => (await post("/api/auth/register", {
    name: email, email, password: "correct horse battery",
  })).cookie!;
  const ownerCookie = await register("delete-owner@example.com");
  const otherCookie = await register("delete-other@example.com");
  const connect = async (cookie: string, name: string) => {
    const authorization = await post("/api/device/authorize", { name, os: "linux", arch: "x64" });
    await post("/api/device/approve", { userCode: authorization.body.userCode }, cookie);
    const connected = await post("/api/device/token", { deviceCode: authorization.body.deviceCode });
    return { id: connected.body.deviceId as string, token: connected.body.token as string };
  };
  const ownerDevice = await connect(ownerCookie, "Owner");
  const otherDevice = await connect(otherCookie, "Other");
  const createSkill = async (name: string) => {
    const files = [{ path: "SKILL.md", content: `---\nname: ${name}\ndescription: fixture\n---\n` }];
    const draft = await post("/api/skills", { name, title: name, description: "fixture", files }, ownerCookie);
    return post(`/api/skills/${draft.body.id}/publish`, {}, ownerCookie);
  };
  const skill = await createSkill("protected-skill");
  const deletion = (token: string | undefined, body = { expectedRevision: skill.body.revision }) => request(
    `/api/device/skills/${skill.body.id}`,
    { method: "DELETE", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) },
  );
  assert.equal((await deletion(undefined)).response.status, 401);
  assert.equal((await deletion("invalid")).response.status, 401);
  assert.equal((await deletion(otherDevice.token)).response.status, 404);

  await instance.db.run("UPDATE device_tokens SET revoked_at=? WHERE device_id=?", Date.now(), ownerDevice.id);
  assert.equal((await deletion(ownerDevice.token)).response.status, 401);

  const disconnectedDevice = await connect(ownerCookie, "Disconnected");
  const row = await instance.db.get<{payload:string}>("SELECT payload FROM workspace_devices WHERE device_id=?", disconnectedDevice.id);
  const payload = JSON.parse(row!.payload);
  payload.disconnectedAt = new Date().toISOString();
  await instance.db.run("UPDATE workspace_devices SET payload=?,disconnected=1 WHERE device_id=?", JSON.stringify(payload), disconnectedDevice.id);
  assert.equal((await deletion(disconnectedDevice.token)).response.status, 401);

  const accountRemoved = await request(`/api/skills/${skill.body.id}`, { method: "DELETE" }, ownerCookie);
  assert.equal(accountRemoved.response.status, 200);
  assert.deepEqual(accountRemoved.body, { ok: true });
  const workspace = (await request("/api/workspace", {}, ownerCookie)).body;
  assert.ok(workspace.retiredSkills.some((item: any) => item.id === skill.body.id && !item.selected && !item.enabled));
});

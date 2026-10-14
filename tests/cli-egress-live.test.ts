import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createApp } from "../server/app.ts";

async function runCli(environment: Record<string, string>, expectedExit = 0) {
  const child = spawn(process.execPath, ["--import", "tsx", "cli/index.ts", "sync"], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });
  const exit = await new Promise<number | null>((done, reject) => {
    child.once("exit", done);
    child.once("error", reject);
  });
  assert.equal(exit, expectedExit, output);
}

test("stable CLI syncs read no workspace blobs and do not repost receipts", { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "equip-cli-egress-"));
  const instance = await createApp({ dataDir: join(root, "server"), autoUpdateIntervalMs: 0 });
  const listener = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>(done => listener.once("listening", done));
  const upstream = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  let receiptUploads = 0;
  const desiredPolls: Array<{ validator?: string; status: number; bytes: number }> = [];
  const proxy = createServer(async (request, response) => {
    if (request.url === "/api/device/receipts") receiptUploads++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const forwardedHeaders = { ...request.headers };
    // Match Vercel's external rewrite rather than forwarding every header verbatim.
    delete forwardedHeaders["if-none-match"];
    const forwarded = await fetch(`${upstream}${request.url}`, {
      method: request.method,
      headers: forwardedHeaders as Record<string, string>,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : Buffer.concat(chunks),
    });
    const headers = Object.fromEntries(forwarded.headers.entries());
    delete headers["content-encoding"];
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    response.writeHead(forwarded.status, headers);
    const body = Buffer.from(await forwarded.arrayBuffer());
    if (request.url === "/api/device/desired") {
      const validator = request.headers["x-equip-if-none-match"];
      desiredPolls.push({ validator: typeof validator === "string" ? validator : undefined, status: forwarded.status, bytes: body.length });
    }
    response.end(body);
  });
  proxy.listen(0, "127.0.0.1");
  await new Promise<void>(done => proxy.once("listening", done));
  t.after(async () => {
    await new Promise<void>((done, reject) => proxy.close(error => error ? reject(error) : done()));
    await new Promise<void>((done, reject) => listener.close(error => error ? reject(error) : done()));
    await instance.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  let blobReads = 0;
  const instrumented = new WeakSet<object>();
  const instrument = (store: any) => {
    if (instrumented.has(store)) return;
    instrumented.add(store);
    for (const method of ["get", "all"] as const) {
      const original = store[method].bind(store);
      store[method] = (sql: string, ...values: unknown[]) => {
        if (/SELECT\s+(?:workspace|payload|hash,files)\b/i.test(sql)) blobReads++;
        return original(sql, ...values);
      };
    }
    const transaction = store.transaction.bind(store);
    store.transaction = (work: (transactionStore: any) => Promise<unknown>, options?: unknown) =>
      transaction((transactionStore: any) => {
        instrument(transactionStore);
        return work(transactionStore);
      }, options);
  };
  instrument(instance.db);
  let cookie = "";
  const request = async (path: string, init: RequestInit = {}, token?: string) => {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    if (cookie) headers.set("cookie", cookie);
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await fetch(`${upstream}${path}`, { ...init, headers });
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    const body = await response.json();
    assert.ok(response.ok, `${response.status} ${JSON.stringify(body)}`);
    return body as any;
  };
  const post = (path: string, body: unknown, token?: string) =>
    request(path, { method: "POST", body: JSON.stringify(body) }, token);
  await post("/api/auth/register", {
    name: "CLI egress",
    email: `cli-egress-${Date.now()}@example.com`,
    password: "test-password-123",
  });
  const files = [{
    path: "SKILL.md",
    content: "---\nname: egress-test\ndescription: CLI egress fixture\n---\n# Stable\n",
  }];
  const draft = await post("/api/skills", {
    title: "Egress test",
    name: "egress-test",
    description: "CLI egress fixture",
    files,
  });
  const skill = await post(`/api/skills/${draft.id}/publish`, {});
  const authorization = await post("/api/device/authorize", {
    name: "Egress client",
    os: "linux",
    arch: "x64",
  });
  await post("/api/device/approve", { userCode: authorization.userCode });
  const device = await post("/api/device/token", { deviceCode: authorization.deviceCode });
  const equipHome = join(root, "client");
  const target = join(root, "target");
  await import("node:fs/promises").then(fs => fs.mkdir(equipHome, { recursive: true }));
  await writeFile(join(equipHome, "state.json"), JSON.stringify({
    token: device.token,
    deviceId: device.deviceId,
    server: base,
    name: "Egress client",
    autoDetect: false,
    targets: [{ id: "codex", path: target }],
  }), { mode: 0o600 });
  const environment = {
    EQUIP_HOME: equipHome,
    EQUIP_AGENT_HOME: join(root, "agent-home"),
    EQUIP_SKILLS_ROOT: resolve("node_modules/skills"),
    EQUIP_NO_SERVICE: "1",
  };

  await runCli(environment);
  await runCli(environment);
  receiptUploads = 0;
  blobReads = 0;
  desiredPolls.length = 0;
  await runCli(environment);
  await runCli(environment);
  assert.equal(desiredPolls.length, 4, "each sync still polls before and after its heartbeat");
  for (const poll of desiredPolls) {
    assert.ok(poll.validator, "cached polls must forward the custom validator");
    assert.equal(poll.status, 304, "unchanged polls must return 304 at the origin");
    assert.equal(poll.bytes, 0, "origin 304 responses must have no body");
  }
  assert.equal(receiptUploads, 0, "stable syncs must not upload identical receipts");
  assert.equal(blobReads, 0, "stable syncs must not read workspace, device, or bundle blobs");

  await writeFile(join(target, "egress-test/SKILL.md"), `${files[0].content}\nlocal edit\n`);
  await runCli(environment, 1);
  await post(`/api/devices/${device.deviceId}/resolve`, {
    skillId: skill.id,
    agent: "codex",
    action: "replace",
  });
  receiptUploads = 0;
  await runCli(environment);
  assert.equal(receiptUploads, 1, "a queued resolution must force a new receipt acknowledgement");
  assert.equal(await readFile(join(target, "egress-test/SKILL.md"), "utf8"), files[0].content);
});

import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { watch } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "esbuild";
import { createApp } from "../server/app.ts";
import { CLI_RELEASE_VERSION, releasePayload } from "../shared/release.ts";

const exec = promisify(execFile);

async function waitForState(
  statePath: string,
  check: (state: any) => boolean | Promise<boolean>,
  // A cold Windows CI runner can spend well over 10 s on a worker's first sync.
  timeout = 30_000,
) {
  return new Promise<void>((resolve, reject) => {
    let checking = false;
    let pending = true;
    let settled = false;
    const watcher = watch(join(statePath, ".."), { persistent: false }, () => {
      pending = true;
      void inspect();
    });
    const timer = setTimeout(() => finish(new Error("Timed out waiting for worker state.")), timeout);
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error);
      else resolve();
    };
    const inspect = async () => {
      if (checking || settled) return;
      checking = true;
      try {
        while (pending && !settled) {
          pending = false;
          const state = await readFile(statePath, "utf8")
            .then(value => JSON.parse(value))
            .catch(error => {
              if (error.code === "ENOENT" || error instanceof SyntaxError) return undefined;
              throw error;
            });
          if (state && await check(state)) finish();
        }
      } catch (error) {
        finish(error);
      } finally {
        checking = false;
      }
    };
    watcher.once("error", finish);
    void inspect();
  });
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  child.kill("SIGTERM");
  await exited;
}

test("a rejected worker update stays visible without blocking skill installation", { timeout: 90_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "equip-worker-update-"));
  let instance: Awaited<ReturnType<typeof createApp>> | undefined;
  let upstreamListener: Server | undefined;
  let proxy: ReturnType<typeof createSecureServer> | undefined;
  const workers = new Set<ChildProcess>();
  t.after(async () => {
    await Promise.all([...workers].map(stop));
    if (proxy?.listening) await new Promise<void>(resolve => proxy!.close(() => resolve()));
    if (upstreamListener?.listening)
      await new Promise<void>(resolve => upstreamListener!.close(() => resolve()));
    await instance?.close();
    await rm(root, { recursive: true, force: true });
  });
  instance = await createApp({ dataDir: join(root, "server"), autoUpdateIntervalMs: 0 });
  upstreamListener = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => upstreamListener.once("listening", resolve));
  const upstream = `http://127.0.0.1:${(upstreamListener.address() as AddressInfo).port}`;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const bundle = join(root, "equip.cjs");
  await build({
    entryPoints: [resolve("cli/index.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22.20",
    external: ["skills"],
    plugins: [{
      name: "test-release-key",
      setup(buildApi) {
        buildApi.onLoad({ filter: /[\\/]cli[\\/]update\.ts$/ }, async args => {
          const source = await readFile(args.path, "utf8");
          const contents = source.replace(
            /export const RELEASE_PUBLIC_KEY = `[^`]+`;/,
            `export const RELEASE_PUBLIC_KEY = ${JSON.stringify(publicKeyPem)};`,
          );
          assert.notEqual(contents, source, "the bundled worker must use the test release key");
          return { contents, loader: "ts" };
        });
      },
    }],
  });
  const certificateKey = join(root, "localhost-key.pem");
  const certificate = join(root, "localhost-cert.pem");
  await exec("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    "-keyout", certificateKey, "-out", certificate,
  ]);
  let validArtifact = false;
  let manifestRequests = 0;
  const secureProxy = createSecureServer({
    key: await readFile(certificateKey),
    cert: await readFile(certificate),
  }, async (request, response) => {
    if (request.url === "/cli/manifest") {
      manifestRequests++;
      const origin = `https://127.0.0.1:${(secureProxy.address() as AddressInfo).port}`;
      const payload = {
        schema: 1 as const,
        version: CLI_RELEASE_VERSION,
        node: ">=22.20.0",
        skillsVersion: "1.7.0",
        skillsIntegrity: `sha512-${Buffer.alloc(64, 4).toString("base64")}`,
        sha256: validArtifact
          ? createHash("sha256").update(await readFile(bundle)).digest("hex")
          : "0".repeat(64),
        url: `${origin}/cli/equip.cjs`,
        origin,
      };
      const signature = sign(null, Buffer.from(releasePayload(payload)), privateKey).toString("base64");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ...payload, signature }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const forwarded = await fetch(`${upstream}${request.url}`, {
      method: request.method,
      headers: request.headers as Record<string, string>,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : Buffer.concat(chunks),
    });
    const headers = Object.fromEntries(forwarded.headers.entries());
    delete headers["content-encoding"];
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    response.writeHead(forwarded.status, headers);
    response.end(Buffer.from(await forwarded.arrayBuffer()));
  });
  proxy = secureProxy;
  proxy.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => proxy.once("listening", resolve));
  const base = `https://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
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
    name: "Worker update test",
    email: `worker-${Date.now()}@example.com`,
    password: "test-password-123",
  });
  const files = [{
    path: "SKILL.md",
    content: "---\nname: worker-live\ndescription: Worker update regression\n---\n# Installed\n",
  }];
  const draft = await post("/api/skills", {
    title: "Worker live",
    name: "worker-live",
    description: "Worker update regression",
    files,
  });
  await post(`/api/skills/${draft.id}/publish`, {});
  const authorization = await post("/api/device/authorize", {
    name: "Worker client", os: "linux", arch: "x64",
  });
  await post("/api/device/approve", { userCode: authorization.userCode });
  const device = await post("/api/device/token", { deviceCode: authorization.deviceCode });
  const equipHome = join(root, "client");
  const target = join(root, "target");
  await mkdir(equipHome, { recursive: true });
  const statePath = join(equipHome, "state.json");
  await writeFile(statePath, JSON.stringify({
    token: device.token,
    deviceId: device.deviceId,
    server: base,
    name: "Worker client",
    autoDetect: false,
    targets: [{ id: "codex", path: target }],
  }), { mode: 0o600 });
  const environment = {
    ...process.env,
    NODE_EXTRA_CA_CERTS: certificate,
    EQUIP_HOME: equipHome,
    EQUIP_AGENT_HOME: join(root, "agent-home"),
    EQUIP_SKILLS_ROOT: resolve("node_modules/skills"),
    EQUIP_NO_SERVICE: "1",
  };
  let output = "";
  const startWorker = () => {
    const child = spawn(process.execPath, [bundle, "worker"], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", chunk => { output += chunk; });
    child.stderr?.on("data", chunk => { output += chunk; });
    workers.add(child);
    child.once("exit", () => workers.delete(child));
    return child;
  };
  // Reports how long each worker phase took and, on failure, what the worker printed.
  const phase = async (name: string, completion: Promise<void>) => {
    const started = Date.now();
    try {
      await completion;
    } catch (error) {
      const state = await readFile(statePath, "utf8").catch(() => "(no state)");
      throw new Error(`${name}: ${(error as Error).message}\nstate: ${state}\nworker output:\n${output}`);
    }
    t.diagnostic(`${name} took ${Date.now() - started} ms`);
  };
  const firstCompletion = waitForState(statePath, async state =>
    state.lastUpdateError?.includes("reuses the current Equip version") &&
      await readFile(join(target, "worker-live", "SKILL.md"), "utf8").then(() => true).catch(() => false),
  );
  const firstWorker = startWorker();
  await phase("rejected update", firstCompletion);
  await stop(firstWorker);
  const status = await exec(process.execPath, [bundle, "status"], { env: environment });
  const visible = JSON.parse(status.stdout);
  assert.equal(visible.lastError, undefined);
  assert.match(visible.lastUpdateError, /reuses the current Equip version/);
  assert.equal(await readFile(join(target, "worker-live", "SKILL.md"), "utf8"), files[0].content);
  assert.equal(manifestRequests, 1);

  const failedState = JSON.parse(await readFile(statePath, "utf8"));
  const throttledCompletion = waitForState(
    statePath,
    state => !!state.lastSync && state.lastSync !== failedState.lastSync,
  );
  const secondWorker = startWorker();
  await phase("throttled check", throttledCompletion);
  await stop(secondWorker);
  assert.equal(manifestRequests, 1, "a recent failed update check must be throttled");
  const throttledState = JSON.parse(await readFile(statePath, "utf8"));
  assert.match(throttledState.lastUpdateError, /reuses the current Equip version/);

  throttledState.lastUpdateCheck = "2000-01-01T00:00:00.000Z";
  await writeFile(statePath, JSON.stringify(throttledState, null, 2), { mode: 0o600 });
  validArtifact = true;
  const recoveredCompletion = waitForState(
    statePath,
    state => manifestRequests === 2 && state.lastUpdateError === undefined &&
      !!state.lastSync && state.lastSync !== throttledState.lastSync,
  );
  const thirdWorker = startWorker();
  await phase("recovered update", recoveredCompletion);
  await stop(thirdWorker);
  const recoveredStatus = JSON.parse((await exec(process.execPath, [bundle, "status"], { env: environment })).stdout);
  assert.equal(recoveredStatus.lastUpdateError, undefined);
});

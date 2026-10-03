#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname, homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  DesiredState,
  DeviceAuthorization,
  Receipt,
} from "../shared/types.ts";
import {
  getCompatibility,
  getDetectedAgents,
  resolveSkill,
} from "../shared/upstream.ts";
import { serviceRemoval, writeService } from "./service.ts";
import { flushReceiptOutbox, queueReceiptBatch } from "./outbox.ts";
import { synchronize, type AgentTarget } from "./sync.ts";
import { selectAgentTargets } from "./targets.ts";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const command = args.shift() ?? "status";
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);
const targetOption = () => option("--target") || process.env.EQUIP_TARGET;
const agentOption = () => option("--agent") || process.env.EQUIP_AGENT;
const agentHome = process.env.EQUIP_AGENT_HOME
  ? resolve(process.env.EQUIP_AGENT_HOME)
  : undefined;
const equipHome = resolve(process.env.EQUIP_HOME || join(homedir(), ".equip"));
const server = (
  option("--server") ||
  process.env.EQUIP_SERVER ||
  "http://localhost:4310"
).replace(/\/$/, "");
const statePath = join(equipHome, "state.json");
const receiptsPath = join(equipHome, "receipts-outbox.json");
type State = {
  token?: string;
  deviceId?: string;
  server?: string;
  name?: string;
  targets?: AgentTarget[];
  autoDetect?: boolean;
  service?: { path: string; label: string };
  profile?: string;
  project?: string;
  lastSync?: string;
  lastError?: string;
  lastUpdateCheck?: string;
};
async function state(): Promise<State> {
  return JSON.parse(await readFile(statePath, "utf8").catch(() => "{}"));
}
async function save(value: State) {
  await mkdir(equipHome, { recursive: true });
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temporary, statePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
async function saveWorkerFields(
  basis: State,
  fields: Pick<State, "lastSync" | "lastError" | "lastUpdateCheck">,
) {
  const latest = await state();
  if (latest.deviceId !== basis.deviceId || latest.token !== basis.token)
    return;
  await save({ ...latest, ...fields });
}
async function request<T>(
  path: string,
  init: RequestInit = {},
  token?: string,
  base = server,
): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
async function flushReceipts(s: State, base: string) {
  await flushReceiptOutbox(receiptsPath, s.deviceId, (batch) =>
    request(
      "/api/device/receipts",
      {
        method: "POST",
        body: JSON.stringify({
          generation: batch.generation,
          receipts: batch.receipts,
        }),
      },
      s.token,
      base,
    ),
  );
}
async function postReceipts(
  s: State,
  base: string,
  generation: number,
  receipts: Receipt[],
) {
  await queueReceiptBatch(receiptsPath, {
    deviceId: s.deviceId,
    generation,
    receipts,
  });
  await flushReceipts(s, base);
}
async function targetsFromFlags(): Promise<AgentTarget[]> {
  const compatibility = await getCompatibility(agentHome);
  const detected = await getDetectedAgents(agentHome);
  const ids = (option("--agents") || agentOption())?.split(",").filter(Boolean);
  const project = option("--project");
  const profile = option("--profile");
  return selectAgentTargets(
    compatibility.agents,
    detected,
    ids,
    project,
    profile,
  );
}
function uniqueTargets(targets: AgentTarget[]) {
  return [
    ...new Map(
      targets.map((t) => [
        [t.id, t.path, t.profile ?? "", t.project ?? ""].join("\0"),
        t,
      ]),
    ).values(),
  ];
}
async function stopService(s: State) {
  if (!s.service) return;
  const removal = await serviceRemoval(
    process.argv[1],
    equipHome,
    s.server || server,
  ).catch(() => null);
  if (
    !removal ||
    removal.path !== s.service.path ||
    removal.label !== s.service.label
  )
    return;
  const owned = await readFile(removal.path, "utf8")
    .then((content) => content.includes(equipHome))
    .catch(() => false);
  if (!owned) return;
  for (const command of removal.commands)
    await exec(command[0], command.slice(1)).catch(() => {});
  await rm(removal.path, { force: true });
  delete s.service;
}
class Disconnected extends Error {}
async function installSkillsRuntime(version: string) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`Invalid skills version in update manifest: ${version}`);
  const runtime = process.env.EQUIP_SKILLS_ROOT
    ? resolve(process.env.EQUIP_SKILLS_ROOT, "../..")
    : join(equipHome, "runtime");
  await mkdir(runtime, { recursive: true });
  const args = [
    "install",
    "--no-audit",
    "--no-fund",
    "--no-save",
    "--prefix",
    runtime,
    `skills@${version}`,
  ];
  const npmCli = process.env.EQUIP_NPM_CLI || process.env.npm_execpath;
  if (npmCli) {
    await exec(process.execPath, [npmCli, ...args], { timeout: 180_000 });
    return;
  }
  const executable =
    platform() === "win32"
      ? join(dirname(process.execPath), "npm.cmd")
      : join(dirname(process.execPath), "npm");
  const present = await readFile(executable)
    .then(() => true)
    .catch(() => false);
  if (!present)
    throw new Error(
      "A skills runtime update is available, but this installation has no npm. Re-run the Equip installer to update its managed runtime.",
    );
  if (platform() === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
    await exec(
      comspec,
      ["/d", "/s", "/c", [quote(executable), ...args.map(quote)].join(" ")],
      { timeout: 180_000 },
    );
  } else await exec(executable, args, { timeout: 180_000 });
}
async function maybeUpdate(s: State) {
  if (
    Date.now() - Date.parse(s.lastUpdateCheck ?? "") < 60 * 60_000 ||
    !process.argv[1].endsWith(".cjs")
  )
    return false;
  const base = s.server || server;
  const response = await fetch(`${base}/cli/manifest`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return false;
  const manifest = (await response.json()) as {
    version: string;
    sha256: string;
    skillsVersion: string;
    url: string;
  };
  s.lastUpdateCheck = new Date().toISOString();
  const compatibility = await getCompatibility(agentHome);
  let changed = false;
  if (manifest.skillsVersion !== compatibility.version) {
    await installSkillsRuntime(manifest.skillsVersion);
    changed = true;
  }
  const executable = resolve(process.argv[1]);
  const current = await readFile(executable);
  if (createHash("sha256").update(current).digest("hex") !== manifest.sha256) {
    const artifact = await fetch(new URL(manifest.url, base), {
      signal: AbortSignal.timeout(60_000),
    });
    if (!artifact.ok)
      throw new Error(`CLI update download failed: ${artifact.status}`);
    const data = Buffer.from(await artifact.arrayBuffer());
    if (createHash("sha256").update(data).digest("hex") !== manifest.sha256)
      throw new Error("CLI update hash mismatch");
    const stage = `${executable}.update`;
    const old = `${executable}.previous`;
    await writeFile(stage, data, { mode: 0o755 });
    await rename(executable, old);
    try {
      await rename(stage, executable);
    } catch (error) {
      await rename(old, executable);
      throw error;
    }
    await rm(old, { force: true });
    changed = true;
  }
  await saveWorkerFields(s, { lastUpdateCheck: s.lastUpdateCheck });
  return changed;
}
async function runSync(s: State) {
  if (!s.token) throw new Error("Not connected. Run equip connect.");
  const explicitTarget = targetOption();
  const selected = explicitTarget
    ? [
        {
          id: agentOption() || "custom",
          path: resolve(explicitTarget),
          profile: option("--profile"),
          project: option("--project"),
        },
      ]
    : uniqueTargets([
        ...(s.autoDetect === false ? [] : await targetsFromFlags()),
        ...(s.targets ?? []),
      ]);
  const targets = selected.map((t) => ({ ...t, deviceId: s.deviceId }));
  const base = s.server || server;
  await flushReceipts(s, base);
  await request(
    "/api/device/heartbeat",
    {
      method: "POST",
      body: JSON.stringify({
        name: s.name || hostname(),
        os: platform(),
        arch: process.arch,
        agents: targets.map((t) => ({
          id: t.id,
          name: t.id,
          path: t.path,
          profile: t.profile,
          project: t.project,
        })),
      }),
    },
    s.token,
    base,
  );
  let desired = await request<DesiredState>(
    "/api/device/desired",
    {},
    s.token,
    base,
  );
  if (desired.sourceRequests?.length) {
    for (const sourceRequest of desired.sourceRequests) {
      try {
        const resolved = await resolveSkill(
          sourceRequest.source,
          sourceRequest.name,
        );
        await request(
          "/api/device/source",
          {
            method: "POST",
            body: JSON.stringify({ requestId: sourceRequest.id, resolved }),
          },
          s.token,
          base,
        );
      } catch (error) {
        await request(
          "/api/device/source",
          {
            method: "POST",
            body: JSON.stringify({
              requestId: sourceRequest.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          },
          s.token,
          base,
        ).catch(() => {});
      }
    }
    desired = await request<DesiredState>(
      "/api/device/desired",
      {},
      s.token,
      base,
    );
  }
  if (desired.disconnect) {
    const receipts =
      desired.disconnect === "remove"
        ? await synchronize(
            { generation: desired.generation, skills: [], resolutions: {} },
            targets,
            equipHome,
          )
        : [];
    await postReceipts(s, base, desired.generation, receipts);
    await request(
      "/api/device/disconnected",
      { method: "POST", body: JSON.stringify({ mode: desired.disconnect }) },
      s.token,
      base,
    );
    await rm(statePath, { force: true });
    await stopService(s);
    throw new Disconnected(`Disconnected (${desired.disconnect})`);
  }
  const receipts = await synchronize(desired, targets, equipHome);
  await postReceipts(s, base, desired.generation, receipts);
  if (receipts.every((receipt) => receipt.status === "synchronized"))
    s.lastSync = new Date().toISOString();
  delete s.lastError;
  await saveWorkerFields(s, {
    lastSync: s.lastSync,
    lastError: undefined,
    lastUpdateCheck: s.lastUpdateCheck,
  });
  return receipts;
}
async function openUrl(url: string) {
  const tool =
    platform() === "darwin"
      ? "open"
      : platform() === "win32"
        ? "cmd"
        : "xdg-open";
  const toolArgs = platform() === "win32" ? ["/c", "start", "", url] : [url];
  await exec(tool, toolArgs).catch(() => {});
}
async function ensureService(s: State) {
  if (
    s.service ||
    has("--no-service") ||
    process.env.EQUIP_NO_SERVICE ||
    has("--once")
  )
    return;
  const def = await writeService(
    process.argv[1],
    equipHome,
    s.server || server,
  );
  s.service = { path: def.path, label: def.label };
  await save(s);
  try {
    for (const serviceCommand of def.enableCommands)
      await exec(serviceCommand[0], serviceCommand.slice(1));
  } catch (error) {
    delete s.service;
    await save(s);
    await rm(def.path, { force: true });
    throw error;
  }
  console.log(`Background worker started: ${def.path}`);
}

async function main() {
  if (command === "connect") {
    const existing = await state();
    if (existing.token) {
      const requestedServer = option("--server") || process.env.EQUIP_SERVER;
      if (
        requestedServer &&
        requestedServer.replace(/\/$/, "") !== existing.server
      )
        throw new Error(
          "Already connected to another server; disconnect first",
        );
      const receipts = await runSync(existing);
      console.log(
        `Connected and synchronized ${receipts.filter((r) => r.status === "synchronized").length} installation(s).`,
      );
      try {
        await ensureService(existing);
      } catch (error) {
        console.error(
          `Synchronized, but background service was unavailable: ${error instanceof Error ? error.message : error}`,
        );
      }
      return;
    }
    const deviceName =
      option("--name") || process.env.EQUIP_DEVICE_NAME || hostname();
    const auth = await request<DeviceAuthorization>("/api/device/authorize", {
      method: "POST",
      body: JSON.stringify({
        name: deviceName,
        os: platform(),
        arch: process.arch,
      }),
    });
    console.log(`Open ${auth.verificationUri}\nCode: ${auth.userCode}`);
    if (
      process.stdout.isTTY &&
      !has("--headless") &&
      !process.env.EQUIP_HEADLESS
    ) {
      console.log("Press Enter to open your browser.");
      await new Promise<void>((r) => process.stdin.once("data", () => r()));
      await openUrl(auth.verificationUri);
    }
    const deadline = Date.now() + auth.expiresIn * 1000;
    let connected: { token: string; deviceId: string } | undefined;
    while (Date.now() < deadline) {
      const response = await fetch(`${server}/api/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: auth.deviceCode }),
      });
      if (response.ok) {
        connected = await response.json();
        break;
      }
      if (response.status !== 428)
        throw new Error(`${response.status} ${await response.text()}`);
      await new Promise((r) =>
        setTimeout(r, Math.max(1, auth.interval) * 1000),
      );
    }
    if (!connected) throw new Error("Authorization expired");
    const configuredTarget = targetOption();
    const explicitTargets = configuredTarget
      ? [
          {
            id: agentOption() || "custom",
            path: resolve(configuredTarget),
            profile: option("--profile"),
            project: option("--project"),
          },
        ]
      : [];
    const noDetect = has("--no-detect") || explicitTargets.length > 0;
    const s: State = {
      ...connected,
      server,
      name: deviceName,
      targets: noDetect ? explicitTargets : await targetsFromFlags(),
      autoDetect: !noDetect,
    };
    await save(s);
    const receipts = await runSync(s);
    console.log(
      `Connected and synchronized ${receipts.filter((r) => r.status === "synchronized").length} installation(s).`,
    );
    try {
      await ensureService(s);
    } catch (error) {
      console.error(
        `Synchronized, but background service was unavailable: ${error instanceof Error ? error.message : error}`,
      );
    }
    return;
  }
  if (command === "sync") {
    const receipts = await runSync(await state());
    for (const r of receipts)
      console.log(
        `${r.status.padEnd(12)} ${r.agent}/${r.skillId}${r.message ? ` — ${r.message}` : ""}`,
      );
    return;
  }
  if (command === "worker") {
    let delay = 2_000;
    for (;;)
      try {
        const s = await state();
        if (await maybeUpdate(s)) {
          if (platform() === "win32") {
            const child = spawn(
              process.execPath,
              [resolve(process.argv[1]), "worker"],
              { detached: true, stdio: "ignore", env: process.env },
            );
            child.unref();
          }
          return;
        }
        await runSync(s);
        delay = 30_000;
        await new Promise((r) => setTimeout(r, delay));
      } catch (e) {
        if (e instanceof Disconnected) return;
        const s = await state();
        await saveWorkerFields(s, {
          lastError: e instanceof Error ? e.message : String(e),
        });
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 60_000);
      }
  }
  if (command === "disconnect") {
    const s = await state();
    const mode = has("--remove") ? "remove" : "retain";
    if (s.token) {
      if (mode === "remove")
        await synchronize(
          { generation: Date.now(), skills: [], resolutions: {} },
          uniqueTargets([...(await targetsFromFlags()), ...(s.targets ?? [])]),
          equipHome,
        );
      await request(
        "/api/device/disconnected",
        { method: "POST", body: JSON.stringify({ mode }) },
        s.token,
        s.server || server,
      ).catch(() => {});
    }
    await stopService(s);
    await rm(statePath, { force: true });
    console.log(
      `Disconnected; managed skills ${mode === "remove" ? "removed where unchanged" : "retained"}.`,
    );
    return;
  }
  if (command === "profile" || command === "project") {
    const s = await state();
    const operation = args[0] ?? "list";
    const value = args[1];
    s.targets ??= [];
    if (operation === "list") {
      console.log(
        JSON.stringify(
          s.targets.filter((t) =>
            command === "profile" ? !!t.profile : !!t.project,
          ),
          null,
          2,
        ),
      );
      return;
    }
    if (!value)
      throw new Error(`equip ${command} ${operation} requires a value`);
    if (operation === "remove")
      s.targets = s.targets.filter((t) =>
        command === "profile"
          ? t.profile !== value
          : t.project !== resolve(value),
      );
    else if (operation === "add") {
      const compatibility = await getCompatibility(agentHome);
      const ids =
        (option("--agents") || agentOption())?.split(",").filter(Boolean) ?? [];
      if (!ids.length) throw new Error(`equip ${command} add requires --agent`);
      for (const id of ids) {
        const agent = compatibility.agents.find((a) => a.id === id);
        if (!agent) throw new Error(`Unknown agent: ${id}`);
        const project =
          command === "project"
            ? resolve(value)
            : option("--project")
              ? resolve(option("--project")!)
              : undefined;
        const profile = command === "profile" ? value : option("--profile");
        const path = option("--path")
          ? resolve(option("--path")!)
          : project
            ? resolve(project, agent.projectPath)
            : agent.globalPath;
        if (!path)
          throw new Error(
            `${id} requires a project root or an explicit --path`,
          );
        s.targets.push({ id, path, project, profile });
      }
      s.targets = uniqueTargets(s.targets);
    } else throw new Error(`Unknown operation: ${operation}`);
    await save(s);
    console.log(`${command} ${operation}: ${value}`);
    return;
  }
  if (command === "compatibility") {
    console.log(JSON.stringify(await getCompatibility(agentHome), null, 2));
    return;
  }
  if (command === "bootstrap") {
    const url = option("--url");
    if (!url)
      throw new Error(
        "bootstrap requires --url pointing to the server-provided CLI package",
      );
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const output = resolve(
      option("--output") ||
        join(equipHome, "bin", basename(new URL(url).pathname) || "equip"),
    );
    await mkdir(join(output, ".."), { recursive: true });
    await writeFile(output, Buffer.from(await response.arrayBuffer()), {
      mode: 0o755,
    });
    console.log(output);
    return;
  }
  const s = await state();
  console.log(
    JSON.stringify(
      {
        connected: !!s.token,
        deviceId: s.deviceId,
        server: s.server || server,
        targets: s.targets ?? [],
        lastSync: s.lastSync,
        lastError: s.lastError,
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

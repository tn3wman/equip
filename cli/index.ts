#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname, homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
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
import { retainedConfiguredTargets, selectAgentTargets } from "./targets.ts";
import { discoverAgentProfiles } from "./profiles.ts";
import { promoteDirectoryWithRollback, replaceExecutable, runNpmCommand, verifyArtifact, verifyPackageIntegrity, verifyReleaseManifest, verifyReleaseUpgrade } from "./update.ts";
import { CLI_RELEASE_VERSION, type SignedReleaseManifest } from "../shared/release.ts";
import { libraryImport } from "./library.ts";
import { localSkill, syncLocalSkills } from "./local.ts";
import { getDesired } from "./desired.ts";
import { consolidate } from "./consolidate.ts";
import type { RecoveryArchive } from "./recovery.ts";
import { discoverInstructionLocations, supportedInstructionLocations, synchronizeInstructions, syncLocalInstructions } from "./instructions.ts";

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
process.env.EQUIP_SOURCE_CACHE ??= join(equipHome, "source-cache");
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
  const compressed = typeof init.body === "string" && Buffer.byteLength(init.body) > 1_000_000
    ? new Uint8Array(gzipSync(init.body)) : undefined;
  const response = await fetch(`${base}${path}`, {
    ...init,
    ...(compressed ? { body: compressed } : {}),
    headers: {
      "content-type": "application/json",
      ...(compressed ? { "content-encoding": "gzip" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(30_000),
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
  const detected = agentHome
    ? await getDetectedAgents(agentHome)
    : await discoverAgentProfiles();
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
function includedTargets(targets: AgentTarget[], desired: DesiredState) {
  return targets.filter(target => !(desired.excludedAgents ?? []).some(excluded =>
    excluded.agent === target.id && excluded.profile === target.profile &&
    excluded.project === target.project));
}
function locationsForTargets(locations: Awaited<ReturnType<typeof discoverInstructionLocations>>, targets: AgentTarget[]) {
  return locations.filter(location => targets.some(target =>
    target.id === location.agent && target.project === location.project &&
    (target.profile === location.profile || target.aliases?.some(alias => alias.profile === location.profile))));
}
function withRetainedInstructionDestinations(
  desired: DesiredState,
  unavailable: Array<{agent:string;profile?:string;project?:string}>,
): DesiredState {
  if (!unavailable.length) return desired;
  const excludedAgents = [...(desired.excludedAgents ?? [])];
  for (const destination of unavailable) {
    if (!excludedAgents.some(excluded => excluded.agent === destination.agent &&
      excluded.profile === destination.profile && excluded.project === destination.project))
      excludedAgents.push({agent:destination.agent,profile:destination.profile,project:destination.project});
  }
  return {...desired,excludedAgents};
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
async function stageSkillsRuntime(manifest: SignedReleaseManifest) {
  const version = manifest.skillsVersion;
  const runtime = process.env.EQUIP_SKILLS_ROOT
    ? resolve(process.env.EQUIP_SKILLS_ROOT, "../..")
    : join(equipHome, "runtime");
  await mkdir(runtime, { recursive: true });
  const stage = join(runtime, `.skills-${randomUUID()}.stage`);
  const npm = process.env.EQUIP_NPM_CLI || process.env.npm_execpath ||
    (platform() === "win32" ? join(dirname(process.execPath), "npm.cmd") : join(dirname(process.execPath), "npm"));
  const present = await readFile(npm).then(() => true).catch(() => false);
  if (!present)
    throw new Error("A skills runtime update is available, but this installation has no npm. Re-run the Equip installer to update its managed runtime.");
  await mkdir(stage, { recursive: true });
  try {
    const packed = await runNpmCommand(npm, ["pack", `skills@${version}`, "--pack-destination", stage, "--json"]);
    const records = JSON.parse(packed.stdout) as Array<{ filename?: unknown }>;
    const filename = records.length === 1 && typeof records[0]?.filename === "string" ? records[0].filename : "";
    if (!filename || basename(filename) !== filename)
      throw new Error("npm returned an invalid Skills package filename.");
    const tarball = join(stage, filename);
    verifyPackageIntegrity(await readFile(tarball), manifest.skillsIntegrity);
    await runNpmCommand(npm, [
      "install", "--no-audit", "--no-fund", "--no-save", "--ignore-scripts",
      "--prefix", stage, tarball,
    ]);
    const installed = JSON.parse(await readFile(join(stage, "node_modules", "skills", "package.json"), "utf8")) as { version?: unknown };
    if (installed.version !== version)
      throw new Error("The installed skills runtime version does not match the signed release.");
    return { runtime, stage };
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
async function maybeUpdate(s: State) {
  if (
    Date.now() - Date.parse(s.lastUpdateCheck ?? "") < 60 * 60_000 ||
    !process.argv[1].endsWith(".cjs")
  )
    return false;
  const base = s.server || server;
  if (new URL(base).protocol !== "https:") return false;
  const response = await fetch(`${base}/cli/manifest`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return false;
  const manifest = verifyReleaseManifest(await response.json(), base);
  s.lastUpdateCheck = new Date().toISOString();
  const compatibility = await getCompatibility(agentHome);
  const executable = resolve(process.argv[1]);
  const current = await readFile(executable);
  const artifactChanged = createHash("sha256").update(current).digest("hex") !== manifest.sha256;
  verifyReleaseUpgrade(manifest, CLI_RELEASE_VERSION, compatibility.version, artifactChanged);
  let changed = false;
  let nextExecutable: Buffer | undefined;
  if (artifactChanged) {
    const artifact = await fetch(manifest.url, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!artifact.ok)
      throw new Error(`CLI update download failed: ${artifact.status}`);
    const data = Buffer.from(await artifact.arrayBuffer());
    verifyArtifact(data, manifest.sha256);
    nextExecutable = data;
  }
  const stagedSkills = manifest.skillsVersion !== compatibility.version
    ? await stageSkillsRuntime(manifest)
    : undefined;
  const replaceCli = async () => {
    if (nextExecutable) await replaceExecutable(executable, nextExecutable);
  };
  if (stagedSkills) {
    try {
      await promoteDirectoryWithRollback(
        join(stagedSkills.runtime, "node_modules"),
        join(stagedSkills.stage, "node_modules"),
        replaceCli,
      );
    } finally {
      await rm(stagedSkills.stage, { recursive: true, force: true }).catch(() => {});
    }
    changed = true;
  } else if (nextExecutable) {
    await replaceCli();
    changed = true;
  }
  await saveWorkerFields(s, { lastUpdateCheck: s.lastUpdateCheck });
  return changed;
}
async function runSync(s: State) {
  await mkdir(equipHome,{recursive:true});
  const path = join(equipHome,'worker-sync.lock');
  let lock;
  try {lock = await open(path,'wx',0o600);}
  catch {
    const owner = JSON.parse(await readFile(path,'utf8').catch(() => '{}'));
    if (owner.pid) {
      try {process.kill(owner.pid,0);throw new Error('Equip synchronization is already running.');}
      catch(error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}
    }
    await rm(path,{force:true});lock=await open(path,'wx',0o600);
  }
  try {await lock.writeFile(JSON.stringify({pid:process.pid}));return await applyState(s);}
  finally {await lock.close();await rm(path,{force:true});}
}
async function applyState(s: State) {
  if (!s.token) throw new Error("Not connected. Run equip connect.");
  const configuredTargets = retainedConfiguredTargets(
    s.autoDetect,
    s.targets ?? [],
  );
  if (configuredTargets.length !== (s.targets ?? []).length) {
    const latest = await state();
    if (latest.deviceId === s.deviceId && latest.token === s.token) {
      latest.targets = retainedConfiguredTargets(
        latest.autoDetect,
        latest.targets ?? [],
      );
      await save(latest);
    }
    s.targets = configuredTargets;
  }
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
        ...configuredTargets,
      ]);
  const targets = selected.map((t) => ({ ...t, deviceId: s.deviceId }));
  const base = s.server || server;
  const archive: RecoveryArchive = async payload => {
    const result = await request<{archived:boolean}>("/api/device/recovery", {
      method:"POST",body:JSON.stringify(payload),signal:AbortSignal.timeout(60_000),
    }, s.token, base);
    if (result.archived !== true) throw new Error("Equip could not confirm recovery history. Local files were preserved.");
  };
  await flushReceipts(s, base);
  // Remove state written by releases that treated a folder as a live authority.
  await rm(join(equipHome, "library-link.json"), { force: true });
  let desiredBeforeLocal = await getDesired(equipHome, base, s.token);
  let activeTargets = includedTargets(targets, desiredBeforeLocal);
  const allInstructionLocations = await discoverInstructionLocations(targets, {home:agentHome, autoDetect:s.autoDetect});
  let detectedInstructionLocations = locationsForTargets(allInstructionLocations, activeTargets);
  const instructionSupport = supportedInstructionLocations(
    detectedInstructionLocations,
    desiredBeforeLocal.instructions,
    s.deviceId,
  );
  const instructionLocations = instructionSupport.locations;
  const local = await syncLocalSkills(equipHome, activeTargets, desiredBeforeLocal, payload => request("/api/device/local", {
    method: "POST", body: JSON.stringify(payload),
  }, s.token, base));
  if (local.changed) desiredBeforeLocal = await getDesired(equipHome, base, s.token);
  const localInstructions = await syncLocalInstructions(equipHome, instructionLocations, desiredBeforeLocal, payload => request("/api/device/instructions/local", {
    method:"POST", body:JSON.stringify(payload),
  },s.token,base),s.deviceId);
  if (localInstructions.changed) desiredBeforeLocal = await getDesired(equipHome,base,s.token);
  await request(
    "/api/device/heartbeat",
    {
      method: "POST",
      body: JSON.stringify({
        name: s.name || hostname(),
        os: platform(),
        arch: process.arch,
        localSyncPath: join(equipHome, "skills"),
        localSyncError: [...local.errors,...localInstructions.errors].join("\n"),
        instructionLocations,
        instructionUnavailable: [
          ...instructionSupport.unavailable,
          ...targets.filter(t => !t.project && !allInstructionLocations.some(l => l.agent === t.id)).map(t => ({agent:t.id,profile:t.profile,reason:"No verified global instruction integration is available for this agent. Its skills continue to synchronize."})),
        ],
        agents: targets.map((t) => ({
          id: t.id,
          name: t.name ?? t.id,
          path: t.path,
          profile: t.profile,
          project: t.project,
          aliases: t.aliases,
          detection: t.detection,
          detectionPath: t.detectionPath,
        })),
      }),
    },
    s.token,
    base,
  );
  let desired = await getDesired(equipHome,base,s.token);
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
    desired = await getDesired(equipHome, base, s.token);
  }
  activeTargets = includedTargets(targets, desired);
  detectedInstructionLocations = locationsForTargets(allInstructionLocations, activeTargets);
  const currentInstructionSupport = supportedInstructionLocations(detectedInstructionLocations, desired.instructions, s.deviceId);
  const activeInstructionLocations = currentInstructionSupport.locations;
  if (desired.disconnect) {
    const receipts =
      desired.disconnect === "remove"
        ? await synchronize(
            { generation: desired.generation, skills: [], resolutions: {} },
            targets,
            equipHome,
            archive,
          )
        : [];
    if (desired.disconnect === "remove") receipts.push(...await synchronizeInstructions(
      {generation:desired.generation,skills:[],resolutions:{},instructions:[]},allInstructionLocations,equipHome,s.deviceId,archive));
    await postReceipts(s, base, desired.generation, receipts);
    if (receipts.some(receipt => receipt.status !== 'synchronized')) {
      await saveWorkerFields(s,{lastError:'Disconnect removal is waiting for local conflicts to be resolved.'});
      return receipts;
    }
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
  const receipts = await synchronize(desired, targets, equipHome,archive);
  receipts.push(...await synchronizeInstructions(
    withRetainedInstructionDestinations(desired,currentInstructionSupport.unavailable),
    allInstructionLocations,equipHome,s.deviceId,archive));
  await postReceipts(s, base, desired.generation, receipts);
  const migration = await consolidate(equipHome,agentHome ?? homedir(),desired,archive);
  if (command === "tidy") console.log(JSON.stringify(migration,null,2));
  if (receipts.every((receipt) => receipt.status === "synchronized"))
    s.lastSync = new Date().toISOString();
  s.lastError = [...local.errors,...localInstructions.errors,...migration.errors].join("\n") || undefined;
  await saveWorkerFields(s, {
    lastSync: s.lastSync,
    lastError: s.lastError,
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
function retryDelay(response: Response | undefined, interval: number) {
  const value = response?.headers.get("retry-after");
  if (!value) return Math.max(1, interval) * 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.max(0, date - Date.now())
    : Math.max(1, interval) * 1000;
}
async function waitWithinDeadline(milliseconds: number, deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(milliseconds, remaining)),
  );
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
  if (command === "library") {
    const operation = args[0] ?? "status";
    const s = await state();
    if (operation === "status") {
      console.log("Libraries are managed by Equip. Folder imports are one-time copies.");
      return;
    }
    if (!s.token) throw new Error("Connect this computer first: equip connect");
    if (operation === "import" || operation === "connect") {
      if (!args[1]) throw new Error(`Use equip library ${operation} /path/to/library [--name My-library]`);
      const payload = await libraryImport(args[1], option("--name"));
      await request("/api/device/library", {
        method: "POST",
        body: JSON.stringify(payload),
      }, s.token, s.server || server);
      const receipts = await runSync(s);
      console.log(`${payload.name} imported. ${payload.skills.length} skill(s) copied to Equip and ${receipts.filter(r => r.status === "synchronized").length} installation(s) synchronized.${operation === "connect" ? " The folder is not linked." : ""}`);
      return;
    }
    if (operation === "unlink") {
      await request("/api/device/library/unlink", { method: "POST", body: "{}" }, s.token, s.server || server);
      await rm(join(equipHome, "library-link.json"), { force: true });
      console.log("Library unlinked. Selected skills and installations retained.");
      return;
    }
    throw new Error(`Unknown library operation: ${operation}`);
  }
  if (command === "local") {
    const s = await state();
    if (!s.token) throw new Error("Connect this computer first: equip connect");
    if (args[0] === "add" && args[1]) {
      const skill = await localSkill(resolve(args[1]));
      await request("/api/device/local", { method: "POST", body: JSON.stringify({ ...skill, explicit: true }) }, s.token, s.server || server);
      const receipts = await runSync(s);
      console.log(`Published ${skill.name}. ${receipts.filter(r => r.status === "synchronized").length} installation(s) synchronized.`);
      return;
    }
    if (args[0] === "status") {
      const desired = await getDesired(equipHome, s.server || server, s.token);
      console.log(`Local publishing: ${desired.localSync ? "enabled" : "disabled"}. Skill folder: ${join(equipHome, "skills")}`);
      return;
    }
    throw new Error("Use equip local add /path/to/skill or equip local status. Enable automatic local publishing in Computers.");
  }
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
      let response: Response | undefined;
      try {
        response = await fetch(`${server}/api/device/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceCode: auth.deviceCode }),
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(15_000, deadline - Date.now())),
          ),
        });
      } catch {
        await waitWithinDeadline(
          retryDelay(undefined, auth.interval),
          deadline,
        );
        continue;
      }
      if (response.ok) {
        connected = await response.json();
        break;
      }
      const retryable =
        response.status === 408 ||
        response.status === 428 ||
        response.status === 429 ||
        response.status >= 500;
      if (!retryable)
        throw new Error(`${response.status} ${await response.text()}`);
      await waitWithinDeadline(retryDelay(response, auth.interval), deadline);
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
    const explicitSelection =
      explicitTargets.length > 0 ||
      !!option("--agents") ||
      !!agentOption() ||
      !!option("--profile") ||
      !!option("--project");
    const noDetect = has("--no-detect") || explicitSelection;
    const persistedTargets = explicitTargets.length
      ? explicitTargets
      : explicitSelection
        ? await targetsFromFlags()
        : [];
    const s: State = {
      ...connected,
      server,
      name: deviceName,
      targets: persistedTargets,
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
  if (command === "sync" || command === "tidy") {
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
      if (mode === "remove") {
        const targets = uniqueTargets([...(s.autoDetect === false ? [] : await targetsFromFlags()), ...(s.targets ?? [])]);
        const empty = {generation:Date.now(),skills:[],resolutions:{},instructions:[]};
        const locations = await discoverInstructionLocations(targets,{home:agentHome,autoDetect:s.autoDetect});
        const receipts = await synchronize(empty,targets,equipHome);
        receipts.push(...await synchronizeInstructions(empty,locations,equipHome,s.deviceId));
        if (receipts.some(r => r.status !== "synchronized")) throw new Error("Some local files changed. Resolve their conflicts before disconnecting with removal.");
      }
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
      `Disconnected; managed skills and instructions ${mode === "remove" ? "removed where unchanged" : "retained"}.`,
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

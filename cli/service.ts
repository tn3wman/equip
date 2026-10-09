import { link, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform as hostPlatform } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

const xml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
const systemd = (value: string) => `"${value.replace(/([\\"])/g, "\\$1")}"`;
const windows = (value: string) => `"${value.replace(/"/g, '""')}"`;
// PowerShell also treats typographic single quotes as quote characters.
const powershell = (value: string) => `'${value.replace(/['\u2018-\u201b]/g, "$&$&")}'`;
// Older Windows installs registered this script. Remove once no recorded
// service path ends with it (every such install has upgraded or reconnected).
const legacyWindowsScript = "equip-worker.cmd";
/** Whether the worker starts at boot without a login, or only at logon. */
export type ServiceMode = "startup" | "logon";
export interface ServiceRecord {
  path: string;
  label: string;
  mode?: ServiceMode;
}
export interface ServiceDefinition {
  os: NodeJS.Platform;
  label: string;
  path: string;
  content: string;
  /** Required registration; failure means no worker. */
  enableCommands: string[][];
  /** Makes the worker start at boot; platforms without them record no mode. */
  bootCommands?: string[][];
  /** Logon-only registration when bootCommands are refused (Windows refuses S4U to some non-elevated users). */
  fallbackCommands?: string[][];
}
export interface ServiceOptions {
  platform?: NodeJS.Platform;
  home?: string;
  nodePath?: string;
  uid?: number;
  environment?: NodeJS.ProcessEnv;
  pathEnvironmentNames?: string[];
}

async function upstreamPathEnvironmentNames(skillsRoot: string) {
  const source = await readFile(join(skillsRoot, "dist/cli.mjs"), "utf8");
  const start = source.indexOf("const home = homedir();");
  const end = source.indexOf("const agents = {", start);
  if (start < 0 || end < 0)
    throw new Error(
      "Installed skills runtime changed its agent path definitions; refusing to create an incomplete background service",
    );
  const names = new Set(["XDG_CONFIG_HOME"]);
  for (const match of source
    .slice(start, end)
    .matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g))
    names.add(match[1]);
  return [...names];
}

export async function serviceDefinition(
  command: string,
  equipHome: string,
  server: string,
  options: ServiceOptions = {},
): Promise<ServiceDefinition> {
  const os = options.platform ?? hostPlatform();
  const home = options.home ?? homedir();
  const node = options.nodePath ?? process.execPath;
  const uid = options.uid ?? process.getuid?.();
  const environment = options.environment ?? process.env;
  const adjacentSkills = join(
    dirname(command),
    "../runtime/node_modules/skills",
  );
  const skillsRoot =
    environment.EQUIP_SKILLS_ROOT ||
    (existsSync(adjacentSkills)
      ? adjacentSkills
      : join(equipHome, "runtime/node_modules/skills"));
  const pathEnvironmentNames =
    options.pathEnvironmentNames ??
    (await upstreamPathEnvironmentNames(skillsRoot));
  const optionalEnvironment = [
    ["EQUIP_AGENT_HOME", environment.EQUIP_AGENT_HOME],
    ["EQUIP_TARGET", environment.EQUIP_TARGET],
    ["EQUIP_AGENT", environment.EQUIP_AGENT],
    ["EQUIP_DEVICE_NAME", environment.EQUIP_DEVICE_NAME],
    ["EQUIP_NPM_CLI", environment.EQUIP_NPM_CLI],
    ...pathEnvironmentNames.map((name) => [name, environment[name]]),
  ];
  const plistOptional = optionalEnvironment
    .filter((entry): entry is [string, string] => !!entry[1])
    .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
    .join("");
  const suffix = createHash("sha256")
    .update(equipHome)
    .digest("hex")
    .slice(0, 12);
  const label = `dev.equip.sync.${suffix}`;
  if (os === "darwin") {
    const path = join(home, `Library/LaunchAgents/${label}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(command)}</string><string>worker</string></array><key>EnvironmentVariables</key><dict><key>EQUIP_HOME</key><string>${xml(equipHome)}</string><key>EQUIP_SERVER</key><string>${xml(server)}</string><key>EQUIP_SKILLS_ROOT</key><string>${xml(skillsRoot)}</string>${plistOptional}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`;
    return {
      os,
      label,
      path,
      content,
      enableCommands: [["launchctl", "bootstrap", `gui/${uid}`, path]],
    };
  }
  if (os === "linux") {
    const unit = `${label}.service`;
    const path = join(home, `.config/systemd/user/${unit}`);
    const optional = optionalEnvironment
      .filter((entry) => entry[1])
      .map(
        ([key, value]) =>
          `Environment="${key}=${String(value).replace(/"/g, '\\"')}"`,
      )
      .join("\n");
    const content = `[Unit]\nDescription=Equip skill synchronization\nAfter=network-online.target\n[Service]\nExecStart=${systemd(node)} ${systemd(command)} worker\nEnvironment="EQUIP_HOME=${equipHome.replace(/"/g, '\\"')}"\nEnvironment="EQUIP_SERVER=${server.replace(/"/g, '\\"')}"\nEnvironment="EQUIP_SKILLS_ROOT=${skillsRoot.replace(/"/g, '\\"')}"\n${optional}\nRestart=always\nRestartSec=5\n[Install]\nWantedBy=default.target\n`;
    return {
      os,
      label,
      path,
      content,
      enableCommands: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", unit],
      ],
      // Lingering keeps the user manager, and this unit, running across reboots without a login.
      bootCommands: [["loginctl", "enable-linger"]],
    };
  }
  if (os === "win32") {
    const task = `Equip Sync ${suffix}`;
    // New name: upgrades must never rewrite the legacy script, because a
    // running cmd.exe rereads its batch file by byte offset.
    const path = join(equipHome, "equip-service.cmd");
    const optional = optionalEnvironment
      .filter((entry) => entry[1])
      .map(([key, value]) => `set "${key}=${value}"\r\n`)
      .join("");
    // Git credential helpers must fail fast when the worker has no interactive session.
    const content = `@echo off\r\nset "EQUIP_HOME=${equipHome}"\r\nset "EQUIP_SERVER=${server}"\r\nset "EQUIP_SKILLS_ROOT=${skillsRoot}"\r\nset "GCM_INTERACTIVE=never"\r\nset "GIT_TERMINAL_PROMPT=0"\r\n${optional}${windows(node)} ${windows(command)} worker\r\n`;
    // S4U with an AtStartup trigger runs the worker after a reboot with nobody logged on.
    const script = [
      "$ErrorActionPreference='Stop'",
      "$me=[Security.Principal.WindowsIdentity]::GetCurrent().Name",
      `$action=New-ScheduledTaskAction -Execute ${powershell(windows(path))}`,
      "$triggers=@((New-ScheduledTaskTrigger -AtStartup),(New-ScheduledTaskTrigger -AtLogOn -User $me))",
      "$principal=New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Limited",
      "$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)",
      `Register-ScheduledTask -TaskName ${powershell(task)} -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null`,
      // Registration is the commitment; a failed start waits for the next boot or logon.
      `try { Start-ScheduledTask -TaskName ${powershell(task)} } catch {}`,
    ].join("\n");
    return {
      os,
      label,
      path,
      content,
      // The boot task and the logon task are alternatives; there is no base registration.
      enableCommands: [],
      bootCommands: [
        [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
      ],
      fallbackCommands: [
        ["schtasks", "/Create", "/F", "/SC", "ONLOGON", "/TN", task, "/TR", windows(path)],
        ["schtasks", "/Run", "/TN", task],
      ],
    };
  }
  throw new Error(`Background service is unsupported on ${os}`);
}

type Run = (file: string, args: string[]) => Promise<unknown>;
async function runAll(commands: string[][], run: Run) {
  for (const [file, ...args] of commands) await run(file, args);
}
/** Registers and starts the worker; returns undefined where boot start does not apply. */
export async function enableService(
  definition: ServiceDefinition,
  run: Run,
): Promise<ServiceMode | undefined> {
  await runAll(definition.enableCommands, run);
  if (!definition.bootCommands) return undefined;
  try {
    await runAll(definition.bootCommands, run);
    return "startup";
  } catch {
    if (definition.fallbackCommands)
      await runAll(definition.fallbackCommands, run);
    return "logon";
  }
}
/**
 * Serializes service lifecycle changes (install, upgrade, disconnect) across
 * processes through `service.lock`. With `wait`, polls until the lock is free;
 * otherwise returns undefined without running `work` while another live
 * process holds it. A lock file stays empty for a moment after creation, so
 * an empty one counts as held until it is stale. Each holder releases only the
 * lock carrying its own token.
 */
export async function withServiceLock<T>(
  equipHome: string,
  work: () => Promise<T>,
  wait = false,
): Promise<T | undefined> {
  const path = join(equipHome, "service.lock");
  const token = randomUUID();
  await mkdir(equipHome, { recursive: true });
  const deadline = Date.now() + 120_000;
  let lock;
  while (!lock) {
    lock = await open(path, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      return undefined;
    });
    if (lock) break;
    // The holder may release between the failed open and these reads; retry.
    const observed = await Promise.all([readFile(path, "utf8"), stat(path)]).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!observed) continue;
    const [owner, info] = observed;
    // Empty or partial contents mean unknown ownership: held until stale.
    let pid = 0;
    try {
      pid = Number(JSON.parse(owner).pid) || 0;
    } catch {}
    if (!(pid ? isAlive(pid) : Date.now() - info.mtimeMs < 60_000)) {
      // Reclaim only the stale file observed above. Two processes reclaiming
      // a crashed holder's lock in the same instant could still both proceed.
      const current = await stat(path).catch(() => undefined);
      if (current?.ino === info.ino && current.mtimeMs === info.mtimeMs)
        await rm(path, { force: true });
      continue;
    }
    if (!wait) return undefined;
    if (Date.now() > deadline)
      throw new Error("Another Equip service change is still running; try again.");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, token }));
    return await work();
  } finally {
    await lock.close();
    const holder = await readFile(path, "utf8").catch(() => "");
    if (holder.includes(token)) await rm(path, { force: true });
  }
}
function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Moves a recorded service to boot-time start by running only the boot
 * commands. The worker tries once for services recorded before modes existed;
 * `retryLogon` (used by `equip connect`, which runs in a login session that
 * Linux lingering may require) also retries services recorded as logon-only.
 *
 * Runs under the service lifecycle lock (skipping while another change holds
 * it) and reads the record inside it. A Windows
 * task still pointing at an older script is re-pointed at a new script that is
 * published once and never rewritten, since a registered task or a running
 * cmd.exe may be using it. The older script stays until disconnect removes
 * both, so a stale record naming it still identifies an owned service.
 * When `save` rejects the record (the computer was disconnected meanwhile),
 * `remove` unregisters what this attempt registered.
 */
export async function upgradeRecordedService(options: {
  equipHome: string;
  definition: () => Promise<ServiceDefinition>;
  load: () => Promise<ServiceRecord | undefined>;
  save: (record: ServiceRecord) => Promise<boolean>;
  remove: () => Promise<void>;
  run: Run;
  retryLogon?: boolean;
}): Promise<ServiceRecord | undefined> {
  return withServiceLock(options.equipHome, async () => {
    const current = await options.load();
    if (!current || current.mode === "startup") return current;
    if (current.mode === "logon" && !options.retryLogon) return current;
    const definition = await options.definition();
    if (!definition.bootCommands) return current;
    if (definition.os === "win32" && definition.path !== current.path)
      await publishService(definition, options.equipHome);
    let record: ServiceRecord;
    try {
      await runAll(definition.bootCommands, options.run);
      record = { path: definition.path, label: current.label, mode: "startup" };
    } catch {
      record = { ...current, mode: "logon" };
    }
    if (await options.save(record)) return record;
    if (record.mode === "startup") await options.remove();
    return undefined;
  });
}

/**
 * Publishes the service script atomically unless a complete, owned one
 * already exists; an existing script is never rewritten.
 */
async function publishService(definition: ServiceDefinition, equipHome: string) {
  await mkdir(dirname(definition.path), { recursive: true });
  const temporary = `${definition.path}.${randomUUID()}.tmp`;
  await writeFile(temporary, definition.content, { mode: 0o700 });
  try {
    await link(temporary, definition.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(definition.path, "utf8");
    if (!existing.includes(equipHome) || !existing.trimEnd().endsWith(" worker"))
      throw new Error(`Refusing to use incomplete or unowned service ${definition.path}`);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeService(
  definition: ServiceDefinition,
  equipHome: string,
) {
  const existing = await readFile(definition.path, "utf8").catch(() => "");
  if (existing && !existing.includes(equipHome))
    throw new Error(`Refusing to overwrite unowned service ${definition.path}`);
  await mkdir(dirname(definition.path), { recursive: true });
  await writeFile(definition.path, definition.content, { mode: 0o700 });
}
export async function serviceRemoval(
  command: string,
  equipHome: string,
  server: string,
  options: ServiceOptions = {},
) {
  const definition = await serviceDefinition(command, equipHome, server, options);
  if (definition.os === "darwin")
    return {
      paths: [definition.path],
      label: definition.label,
      commands: [
        ["launchctl", "bootout", `gui/${process.getuid?.()}`, definition.path],
      ],
    };
  if (definition.os === "linux")
    return {
      paths: [definition.path],
      label: definition.label,
      commands: [
        [
          "systemctl",
          "--user",
          "disable",
          "--now",
          `${definition.label}.service`,
        ],
        ["systemctl", "--user", "daemon-reload"],
      ],
    };
  return {
    // The task name is unchanged, so one delete removes either registration.
    paths: [definition.path, join(dirname(definition.path), legacyWindowsScript)],
    label: definition.label,
    commands: [
      [
        "schtasks",
        "/Delete",
        "/F",
        "/TN",
        `Equip Sync ${definition.label.split(".").pop()}`,
      ],
    ],
  };
}

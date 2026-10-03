import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform as hostPlatform } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
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
export interface ServiceOptions {
  platform?: NodeJS.Platform;
  home?: string;
  nodePath?: string;
  uid?: number;
}

export async function serviceDefinition(
  command: string,
  equipHome: string,
  server: string,
  options: ServiceOptions = {},
) {
  const os = options.platform ?? hostPlatform();
  const home = options.home ?? homedir();
  const node = options.nodePath ?? process.execPath;
  const uid = options.uid ?? process.getuid?.();
  const adjacentSkills = join(
    dirname(command),
    "../runtime/node_modules/skills",
  );
  const skillsRoot =
    process.env.EQUIP_SKILLS_ROOT ||
    (existsSync(adjacentSkills)
      ? adjacentSkills
      : join(equipHome, "runtime/node_modules/skills"));
  const agentHome = process.env.EQUIP_AGENT_HOME;
  const target = process.env.EQUIP_TARGET;
  const agent = process.env.EQUIP_AGENT;
  const optionalEnvironment = [
    ["EQUIP_AGENT_HOME", agentHome],
    ["EQUIP_TARGET", target],
    ["EQUIP_AGENT", agent],
    ["EQUIP_DEVICE_NAME", process.env.EQUIP_DEVICE_NAME],
    ["EQUIP_NPM_CLI", process.env.EQUIP_NPM_CLI],
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
    };
  }
  if (os === "win32") {
    const task = `Equip Sync ${suffix}`;
    const path = join(equipHome, "equip-worker.cmd");
    const optional = optionalEnvironment
      .filter((entry) => entry[1])
      .map(([key, value]) => `set "${key}=${value}"\r\n`)
      .join("");
    const content = `@echo off\r\nset "EQUIP_HOME=${equipHome}"\r\nset "EQUIP_SERVER=${server}"\r\nset "EQUIP_SKILLS_ROOT=${skillsRoot}"\r\n${optional}${windows(node)} ${windows(command)} worker\r\n`;
    return {
      os,
      label,
      path,
      content,
      enableCommands: [
        [
          "schtasks",
          "/Create",
          "/F",
          "/SC",
          "ONLOGON",
          "/TN",
          task,
          "/TR",
          path,
        ],
        ["schtasks", "/Run", "/TN", task],
      ],
    };
  }
  throw new Error(`Background service is unsupported on ${os}`);
}

export async function writeService(
  command: string,
  equipHome: string,
  server: string,
) {
  const definition = await serviceDefinition(command, equipHome, server);
  const existing = await readFile(definition.path, "utf8").catch(() => "");
  if (existing && !existing.includes(equipHome))
    throw new Error(`Refusing to overwrite unowned service ${definition.path}`);
  await mkdir(dirname(definition.path), { recursive: true });
  await writeFile(definition.path, definition.content, { mode: 0o700 });
  return definition;
}
export async function serviceRemoval(
  command: string,
  equipHome: string,
  server: string,
) {
  const definition = await serviceDefinition(command, equipHome, server);
  if (definition.os === "darwin")
    return {
      path: definition.path,
      label: definition.label,
      commands: [
        ["launchctl", "bootout", `gui/${process.getuid?.()}`, definition.path],
      ],
    };
  if (definition.os === "linux")
    return {
      path: definition.path,
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
    path: definition.path,
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

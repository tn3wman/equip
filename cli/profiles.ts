import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  getCompatibility,
  getDetectedAgents,
  getAgentPathEnvironmentNames,
  type UpstreamEnvironmentOverrides,
} from "../shared/upstream.ts";
import type { CompatibleAgent } from "./targets.ts";

export interface DetectedAgentProfile extends CompatibleAgent {
  profile?: string;
  aliases?: Array<{ profile: string; path: string }>;
}

export interface ProfileDiscoveryOptions {
  home?: string;
  environment?: NodeJS.ProcessEnv;
  t3SettingsPath?: string;
}

const profileAgents: Array<{id: "claude-code" | "codex"; prefix: string; variable: "CLAUDE_CONFIG_DIR" | "CODEX_HOME"}> = [
  {
    id: "claude-code",
    prefix: ".claude",
    variable: "CLAUDE_CONFIG_DIR" as const,
  },
  { id: "codex", prefix: ".codex", variable: "CODEX_HOME" as const },
];

function profileName(prefix: string, path: string) {
  const name = basename(path);
  if (name === prefix) return "default";
  if (name.startsWith(`${prefix}_`) || name.startsWith(`${prefix}-`))
    return name.slice(prefix.length + 1);
  return name.replace(/^\.+/, "") || "custom";
}

function conventionalProfileName(prefix: string, name: string) {
  if (name === prefix) return true;
  if (/\.(?:lock|tmp|temp|bak)$/i.test(name)) return false;
  if (!name.startsWith(`${prefix}_`) && !name.startsWith(`${prefix}-`))
    return false;
  return /^[A-Za-z0-9_-]+$/.test(name.slice(prefix.length + 1));
}

async function directory(path: string) {
  return stat(path)
    .then((info) => info.isDirectory())
    .catch(() => false);
}

async function physical(path: string) {
  return realpath(path).catch(() => resolve(path));
}

interface T3Profile {
  id: "claude-code" | "codex";
  root: string;
  profile: string;
}

async function t3Profiles(home: string, settingsPath: string) {
  const settings = await readFile(settingsPath, "utf8")
    .then((content) => JSON.parse(content) as unknown)
    .catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return [];
  const instances = (settings as Record<string, unknown>).providerInstances;
  const values = Array.isArray(instances)
    ? instances
    : instances && typeof instances === "object"
      ? Object.values(instances)
      : [];
  const profiles: T3Profile[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const instance = value as Record<string, unknown>;
    if (instance.enabled !== true) continue;
    const id =
      instance.driver === "claudeAgent"
        ? "claude-code"
        : instance.driver === "codex"
          ? "codex"
          : undefined;
    const config = instance.config;
    const rawHome =
      config && typeof config === "object" && !Array.isArray(config)
        ? (config as Record<string, unknown>).homePath
        : undefined;
    if (!id || typeof rawHome !== "string" || !rawHome.trim()) continue;
    const configured = rawHome.trim();
    const root = configured.startsWith("~/")
      ? resolve(home, configured.slice(2))
      : isAbsolute(configured)
        ? resolve(configured)
        : resolve(home, configured);
    const displayName =
      typeof instance.displayName === "string"
        ? instance.displayName.trim()
        : "";
    profiles.push({
      id,
      root,
      profile: displayName || basename(root).replace(/^\.+/, "") || "custom",
    });
  }
  return profiles;
}

export interface ConfigurationRoot {
  id: "claude-code" | "codex";
  root: string;
  profile?: string;
}

/** Config roots are independent of skill roots, which profiles may share. */
export async function discoverConfigurationRoots(options: ProfileDiscoveryOptions = {}): Promise<ConfigurationRoot[]> {
  const home = resolve(options.home ?? homedir());
  const environment = options.environment ?? (options.home ? {} : process.env);
  const [entries, configuredProfiles] = await Promise.all([
    readdir(home, { withFileTypes: true }).catch(() => []),
    t3Profiles(home, options.t3SettingsPath ?? join(home, ".t3/userdata/settings.json")),
  ]);
  const result: ConfigurationRoot[] = [];
  for (const specification of profileAgents) {
    const defaultRoot = resolve(environment[specification.variable]?.trim() || join(home, specification.prefix));
    const roots = [
      { root: defaultRoot, profile: profileName(specification.prefix, defaultRoot) },
      // Keep the default home when a process uses a custom configuration root.
      { root: join(home, specification.prefix), profile: "default" },
      ...entries.filter(entry => conventionalProfileName(specification.prefix, entry.name))
        .map(entry => ({ root: join(home, entry.name), profile: profileName(specification.prefix, join(home, entry.name)) })),
      ...configuredProfiles.filter(profile => profile.id === specification.id),
    ];
    const seen = new Set<string>();
    for (const candidate of roots) {
      if (!(await directory(candidate.root))) continue;
      const canonical = await physical(candidate.root);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      result.push({ id: specification.id, root: candidate.root,
        ...(resolve(candidate.root) === defaultRoot ? {} : { profile: candidate.profile }) });
    }
  }
  return result;
}

/** Detects each physical CLI configuration root without reading its contents. */
export async function discoverAgentProfiles(
  options: ProfileDiscoveryOptions = {},
): Promise<DetectedAgentProfile[]> {
  const home = resolve(options.home ?? homedir());
  const environment = options.environment ?? (options.home ? {} : process.env);
  const pathEnvironmentNames = await getAgentPathEnvironmentNames();
  const baselineOverrides: UpstreamEnvironmentOverrides = Object.fromEntries(
    pathEnvironmentNames.map((variable) => [
      variable,
      environment[variable]?.trim() || undefined,
    ]),
  );
  const [compatible, detected, entries, configuredProfiles] = await Promise.all([
    getCompatibility(home, baselineOverrides),
    getDetectedAgents(home, baselineOverrides),
    readdir(home, { withFileTypes: true }).catch(() => []),
    t3Profiles(
      home,
      options.t3SettingsPath ?? join(home, ".t3/userdata/settings.json"),
    ),
  ]);
  const specializedIds = new Set<string>(profileAgents.map((agent) => agent.id));
  const result: DetectedAgentProfile[] = detected.filter(
    (agent) => !specializedIds.has(agent.id),
  ).map(agent => ({
    ...agent,
    detection: "configuration" as const,
    detectionPath: agent.globalPath,
  }));

  for (const specification of profileAgents) {
    const inherited = baselineOverrides[specification.variable];
    const defaultRoot = resolve(inherited || join(home, specification.prefix));
    const roots = [
      { root: defaultRoot, profile: profileName(specification.prefix, defaultRoot) },
      ...entries
        .filter(
          (entry) => conventionalProfileName(specification.prefix, entry.name),
        )
        .map((entry) => {
          const root = join(home, entry.name);
          return { root, profile: profileName(specification.prefix, root) };
        }),
      ...configuredProfiles
        .filter((profile) => profile.id === specification.id)
        .map(({ root, profile }) => ({ root, profile })),
    ];
    const seen = new Map<string, DetectedAgentProfile>();
    const seenRoots = new Set<string>();
    const canonicalDefault = await physical(defaultRoot);
    for (const candidate of roots) {
      const { root } = candidate;
      if (!(await directory(root))) continue;
      const canonical = await physical(root);
      if (seenRoots.has(canonical)) continue;
      seenRoots.add(canonical);
      const overrides = { ...baselineOverrides, [specification.variable]: root };
      const scoped = await getCompatibility(home, overrides);
      const agent = scoped.agents.find((item) => item.id === specification.id);
      if (!agent?.globalPath) continue;
      const destination = await physical(agent.globalPath);
      const alias = {
        profile: candidate.profile,
        path: agent.globalPath,
      };
      const existing = seen.get(destination);
      if (existing) {
        if (
          !existing.aliases?.some(
            (item) => item.profile === alias.profile && item.path === alias.path,
          )
        )
          existing.aliases?.push(alias);
        continue;
      }
      const target: DetectedAgentProfile = {
        ...agent,
        detection: "configuration",
        detectionPath: root,
        profile:
          canonical === canonicalDefault
            ? undefined
            : candidate.profile,
        aliases: [alias],
      };
      seen.set(destination, target);
      result.push(target);
    }
  }
  return result;
}

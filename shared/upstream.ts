import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import type { Skill, SkillFile } from "./types.ts";

const exec = promisify(execFile);
const localRequire = createRequire(join(process.cwd(), "package.json"));

async function selectedPackage() {
  const managed = process.env.EQUIP_SKILLS_ROOT
    ? join(process.env.EQUIP_SKILLS_ROOT, "package.json")
    : process.env.EQUIP_HOME
      ? join(process.env.EQUIP_HOME, "runtime/node_modules/skills/package.json")
      : "";
  const packagePath = managed || localRequire.resolve("skills/package.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
    version: string;
  };
  return {
    packagePath,
    pkgRoot: dirname(packagePath),
    packageRequire: createRequire(packagePath),
    version: pkg.version,
  };
}

export interface ResolvedSkill {
  name: string;
  title: string;
  description: string;
  author: string;
  source: string;
  category: string;
  icon: string;
  color: string;
  revision: string;
  files: SkillFile[];
  requirements: string[];
  installs?: number;
}

function hashFiles(files: SkillFile[]) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const bytes = Buffer.from(
      file.content,
      file.encoding === "base64" ? "base64" : "utf8",
    );
    hash
      .update(file.path)
      .update("\0")
      .update(file.encoding ?? "utf8")
      .update("\0")
      .update(String(file.mode ?? 0o644))
      .update("\0")
      .update(bytes)
      .update("\0");
  }
  return hash.digest("hex");
}

async function collect(root: string, dir = root): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === ".equip-data") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(root, full)));
    else if (entry.isFile()) {
      const data = await readFile(full);
      const path = relative(root, full).split("\\").join("/");
      const binary = !Buffer.from(data.toString("utf8"), "utf8").equals(data);
      const mode = (await stat(full)).mode & 0o777;
      files.push({
        path,
        content: data.toString(binary ? "base64" : "utf8"),
        ...(binary ? { encoding: "base64" as const } : {}),
        ...(mode !== 0o644 ? { mode } : {}),
      });
    } else if (entry.isSymbolicLink())
      throw new Error(
        `Skill source contains unsupported symbolic link: ${relative(root, full)}`,
      );
  }
  return files;
}

function frontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  return match ? (parseYaml(match[1]) ?? {}) : {};
}

export async function resolveSkill(
  source: string,
  name?: string,
  options: { isolate?: boolean } = {},
): Promise<ResolvedSkill> {
  const upstream = await selectedPackage();
  const skillsCli = join(upstream.pkgRoot, "bin/cli.mjs");
  const root = await mkdtemp(join(tmpdir(), "equip-source-"));
  await writeFile(join(root, "package.json"), '{"private":true}');
  try {
    const isolatedHome = join(root, "home");
    if (options.isolate) await mkdir(isolatedHome);
    const args = [
      skillsCli,
      "add",
      source,
      "--copy",
      "--agent",
      "universal",
      "--yes",
      "--json",
    ];
    if (name) args.push("--skill", name);
    await exec(process.execPath, args, {
      cwd: root,
      // Device resolution retains local repository credentials. Server resolution
      // must not inherit application secrets, credential helpers, or agent accounts.
      env: options.isolate
        ? sourceProcessEnvironment(isolatedHome)
        : process.env,
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const installed = join(root, ".agents/skills");
    const dirs = (await readdir(installed, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory(),
    );
    if (!dirs.length)
      throw new Error(
        `Upstream skills executable installed no skills from ${source}`,
      );
    if (!name && dirs.length > 1)
      throw new Error(
        `Source contains multiple skills; specify one of: ${dirs.map((entry) => entry.name).join(", ")}`,
      );
    const selected = name ? dirs.find((entry) => entry.name === name) : dirs[0];
    if (!selected)
      throw new Error(`Skill ${name} was not installed from ${source}`);
    const skillDir = join(installed, selected.name);
    const files = await collect(skillDir);
    const md = files.find((f) => f.path.toLowerCase() === "skill.md");
    if (!md) throw new Error("Skill is missing SKILL.md");
    const meta = frontmatter(md.content);
    const skillName = String(meta.name || basename(skillDir));
    const requirements = Array.isArray(meta.requirements)
      ? meta.requirements.map(String)
      : [];
    if (typeof meta.compatibility === "string" && meta.compatibility.trim())
      requirements.push(meta.compatibility.trim());
    const metadata =
      meta.metadata && typeof meta.metadata === "object"
        ? (meta.metadata as Record<string, unknown>)
        : {};
    const lock = JSON.parse(
      await readFile(join(root, "skills-lock.json"), "utf8").catch(
        () => '{"skills":{}}',
      ),
    ) as { skills?: Record<string, { computedHash?: string; ref?: string }> };
    const locked = lock.skills?.[selected.name];
    const resolved = {
      name: skillName,
      title: String(meta.title || skillName),
      description: String(meta.description || ""),
      author: String(
        meta.author || metadata.author || source.split("/")[0] || "Unknown",
      ),
      source,
      category: String(meta.category || "Other"),
      icon: String(meta.icon || "Sparkles"),
      color: String(meta.color || "#7067CF"),
      revision: locked?.ref || locked?.computedHash || hashFiles(files),
      files,
      requirements,
    };
    const cache = resolve(
      process.env.EQUIP_SOURCE_CACHE ||
        join(process.env.EQUIP_DATA_DIR || ".equip-data", "source-cache"),
    );
    await mkdir(cache, { recursive: true });
    const artifact = join(
      cache,
      `${resolved.revision}-${createHash("sha256").update(`${source}\0${skillName}`).digest("hex").slice(0, 16)}.json`,
    );
    const temp = `${artifact}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(resolved), { mode: 0o600 });
    await rename(temp, artifact);
    return resolved;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export const resolveSource = resolveSkill;

export function sourceProcessEnvironment(
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "SystemDrive",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ]) {
    if (environment[key]) result[key] = environment[key];
  }
  return {
    ...result,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND:
      "ssh -F none -o BatchMode=yes -o IdentityAgent=none -o IdentityFile=none -o IdentitiesOnly=yes",
  };
}

export async function checkSkill(
  source: string,
  currentRevision: string,
  name?: string,
  options: { isolate?: boolean } = {},
) {
  const next = await resolveSkill(source, name, options);
  return next.revision === currentRevision
    ? { revision: currentRevision }
    : { revision: next.revision, files: next.files };
}

type UpstreamAgent = {
  displayName: string;
  skillsDir: string;
  globalSkillsDir?: string;
  detectInstalled(): Promise<boolean>;
};
const bindingPromises = new Map<
  string,
  Promise<{
    version: string;
    agents: Record<string, UpstreamAgent>;
    detectInstalledAgents(): Promise<string[]>;
    parseSource(input: string): unknown;
  }>
>();

// skills intentionally publishes no library API. This narrow adapter binds the tested 1.7.0 bundle so
// compatibility and detection remain its source of truth. The signature/version guards fail loudly when
// upstream changes; source installation still delegates to the supported executable above.
export type UpstreamEnvironmentOverrides = Record<
  string,
  string | undefined
>;

function agentPathEnvironmentNames(source: string) {
  const start = source.indexOf("const home = homedir();");
  const end = source.indexOf("const agents = {", start);
  if (start < 0 || end < 0)
    throw new Error(
      "Installed skills bundle signature changed (agent path definitions); refusing an incomplete environment binding",
    );
  const names = new Set(["XDG_CONFIG_HOME"]);
  for (const match of source
    .slice(start, end)
    .matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g))
    names.add(match[1]);
  return [...names].sort();
}

export async function getAgentPathEnvironmentNames() {
  const upstream = await selectedPackage();
  return agentPathEnvironmentNames(
    await readFile(join(upstream.pkgRoot, "dist/cli.mjs"), "utf8"),
  );
}

async function upstreamBinding(
  home?: string,
  environment?: UpstreamEnvironmentOverrides,
) {
  const scopedEnvironment = environment ?? (home ? {} : undefined);
  const upstream = await selectedPackage();
  const cliPath = join(upstream.pkgRoot, "dist/cli.mjs");
  const sourceBytes = await readFile(cliPath);
  const upstreamPathVariables = agentPathEnvironmentNames(
    sourceBytes.toString("utf8"),
  );
  const key = [
    upstream.packagePath,
    upstream.version,
    createHash("sha256").update(sourceBytes).digest("hex"),
    home ? resolve(home) : "<default>",
    ...upstreamPathVariables.map(
      (variable) => scopedEnvironment?.[variable] ?? "",
    ),
  ].join("\0");
  const existing = bindingPromises.get(key);
  if (existing) return existing;
  const bindingPromise = (async () => {
    let source = sourceBytes.toString("utf8");
    const ending =
      "main().finally(() => flushTelemetry().then(() => process.exit(process.exitCode ?? 0)));\nexport {};";
    if (
      !source.includes(ending) ||
      !source.includes("async function detectInstalledAgents()") ||
      !source.includes("const agents = {")
    )
      throw new Error(
        `skills ${upstream.version} bundle signature changed; refusing an unsafe compatibility guess`,
      );
    const cliUrl = pathToFileURL(cliPath).href;
    const base = pathToFileURL(`${dirname(cliPath)}/`).href;
    source = source
      .replace(/from "\.\//g, `from "${base}`)
      .replaceAll("import.meta.url", JSON.stringify(cliUrl))
      .replace(
        'from "yaml"',
        `from "${pathToFileURL(upstream.packageRequire.resolve("yaml")).href}"`,
      )
      .replace(
        'from "tar"',
        `from "${pathToFileURL(upstream.packageRequire.resolve("tar")).href}"`,
      )
      .replace(
        "const home = homedir();",
        `const home = ${JSON.stringify(home || "")} || homedir();`,
      );
    if (home) {
      if (
        !source.includes(
          'const configHome = xdgConfig ?? join(home, ".config");',
        )
      )
        throw new Error(
          `skills ${upstream.version} XDG binding signature changed; refusing an unsafe isolated compatibility guess`,
        );
      source = source.replace(
        'const configHome = xdgConfig ?? join(home, ".config");',
        scopedEnvironment?.XDG_CONFIG_HOME
          ? `const configHome = ${JSON.stringify(scopedEnvironment.XDG_CONFIG_HOME)};`
          : 'const configHome = join(home, ".config");',
      );
    }
    if (scopedEnvironment) {
      for (const variable of upstreamPathVariables)
        source = source.replaceAll(
          `process.env.${variable}`,
          JSON.stringify(scopedEnvironment[variable]),
        );
    }
    source = source.replace(
      ending,
      "export { agents, detectInstalledAgents, parseSource };",
    );
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
    return { version: upstream.version, ...(await import(moduleUrl)) };
  })();
  bindingPromises.set(key, bindingPromise);
  return bindingPromise;
}

export async function getCompatibility(
  home?: string,
  environment?: UpstreamEnvironmentOverrides,
) {
  const binding = await upstreamBinding(home, environment);
  const agents = binding.agents as Record<string, UpstreamAgent>;
  return {
    version: binding.version,
    agents: Object.entries(agents).map(([id, agent]) => ({
      id,
      name: agent.displayName,
      globalPath: agent.globalSkillsDir ?? "",
      projectPath: agent.skillsDir,
    })),
    checkedAt: new Date().toISOString(),
  };
}

export async function getDetectedAgents(
  home?: string,
  environment?: UpstreamEnvironmentOverrides,
) {
  const binding = await upstreamBinding(home, environment);
  const ids = await binding.detectInstalledAgents();
  const compatibility = await getCompatibility(home, environment);
  return compatibility.agents.filter((agent) => ids.includes(agent.id));
}

export async function parseUpstreamSource(source: string) {
  return (await upstreamBinding()).parseSource(source);
}

export const compatibility = getCompatibility;

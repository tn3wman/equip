import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  getCompatibility,
  getDetectedAgents,
  parseUpstreamSource,
  resolveSkill,
  sourceProcessEnvironment,
} from "../shared/upstream.ts";

test("server source subprocess cannot inherit application credentials or Node hooks", async () => {
  const home = await mkdtemp(join(tmpdir(), "equip-isolated-home-"));
  const env = sourceProcessEnvironment(home, {
    ...process.env,
    EQUIP_SOURCE_ENV_PROBE: "test-only",
    GITHUB_TOKEN: "test-only",
    SUPABASE_SECRET_KEY: "test-only",
    SSH_AUTH_SOCK: "test-only",
    NODE_OPTIONS: "--require /does-not-exist/test-only.js",
  });
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "-e",
      'process.stdout.write(JSON.stringify({home:process.env.HOME, inherited:["EQUIP_SOURCE_ENV_PROBE","GITHUB_TOKEN","SUPABASE_SECRET_KEY","SSH_AUTH_SOCK","NODE_OPTIONS"].filter(k=>process.env[k]), gitConfig:process.env.GIT_CONFIG_GLOBAL, interactive:process.env.GIT_TERMINAL_PROMPT}))',
    ],
    { env },
  );
  const result = JSON.parse(stdout);
  assert.deepEqual(result.inherited, []);
  assert.equal(result.home, home);
  assert.equal(result.gitConfig, join(home, ".gitconfig"));
  assert.equal(result.interactive, "0");
});

test("local source resolution captures the complete immutable folder", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "equip-source-test-"));
  const root = join(sandbox, "skill");
  process.env.EQUIP_SOURCE_CACHE = join(sandbox, "cache");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "references"));
  await mkdir(join(root, "node_modules/fixture"), { recursive: true });
  await writeFile(
    join(root, "SKILL.md"),
    "---\nname: source-test\ndescription: Complete source\ncompatibility: Requires Node 24\nmetadata:\n  author: Nested Author\nrequirements:\n  - git\n---\n# Source\n",
  );
  await writeFile(join(root, "scripts/run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(join(root, "references/info.txt"), "reference");
  await writeFile(
    join(root, "node_modules/fixture/data.bin"),
    Buffer.from([0xff, 0xfe, 0x00]),
  );
  const first = await resolveSkill(root);
  const second = await resolveSkill(root);
  assert.equal(first.name, "source-test");
  assert.equal(first.author, "Nested Author");
  assert.equal(first.revision, second.revision);
  assert.deepEqual(first.files.map((f) => f.path).sort(), [
    "SKILL.md",
    "node_modules/fixture/data.bin",
    "references/info.txt",
    "scripts/run.sh",
  ]);
  assert.equal(
    first.files.find((file) => file.path.endsWith("data.bin"))?.encoding,
    "base64",
  );
  assert.deepEqual(first.requirements, ["git", "Requires Node 24"]);
});

test("agent detection uses upstream global definitions and installation markers", async () => {
  const home = await mkdtemp(join(tmpdir(), "equip-agents-test-"));
  const hostConfig = await mkdtemp(join(tmpdir(), "equip-host-config-"));
  const codex = join(home, "custom-codex");
  const claude = join(home, "custom-claude");
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousCodex = process.env.CODEX_HOME;
  const previousClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.CODEX_HOME = codex;
  process.env.CLAUDE_CONFIG_DIR = claude;
  process.env.XDG_CONFIG_HOME = hostConfig;
  await mkdir(codex);
  await mkdir(claude);
  await mkdir(join(home, ".codex"));
  await mkdir(join(home, ".claude"));
  await mkdir(join(hostConfig, "opencode"));
  try {
    const compatibility = await getCompatibility(home);
    assert.equal(
      compatibility.agents.find((agent) => agent.id === "codex")?.globalPath,
      join(home, ".codex/skills"),
    );
    assert.equal(
      compatibility.agents.find((agent) => agent.id === "claude-code")
        ?.globalPath,
      join(home, ".claude/skills"),
    );
    assert.equal(
      compatibility.agents.find((agent) => agent.id === "codex")?.name,
      "Codex",
    );
    assert.ok(
      compatibility.agents
        .filter((agent) => agent.globalPath)
        .every(
          (agent) =>
            agent.globalPath === home ||
            agent.globalPath.startsWith(`${home}${sep}`),
        ),
    );
    const detected = await getDetectedAgents(home);
    assert.ok(detected.some((agent) => agent.id === "codex"));
    assert.ok(detected.some((agent) => agent.id === "claude-code"));
    assert.ok(!detected.some((agent) => agent.id === "universal"));
    assert.ok(!detected.some((agent) => agent.id === "opencode"));
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaude;
  }
});

test("upstream parser accepts SSH source syntax", async () => {
  const parsed = (await parseUpstreamSource(
    "git@github.com:vercel-labs/agent-skills.git",
  )) as { type?: string; url?: string };
  assert.equal(parsed.type, "git");
  assert.match(parsed.url ?? "", /vercel-labs\/agent-skills/);
});

test(
  "live upstream executable installs a public repository skill",
  { timeout: 120_000 },
  async () => {
    const resolved = await resolveSkill(
      "vercel-labs/agent-skills",
      "vercel-react-best-practices",
      { isolate: true },
    );
    assert.equal(resolved.name, "vercel-react-best-practices");
    assert.ok(resolved.files.some((file) => file.path === "SKILL.md"));
    assert.ok(resolved.revision.length >= 40);
  },
);

test("compatibility hot-loads an atomically promoted managed package path", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "equip-runtime-test-"));
  const modules = join(sandbox, "node_modules");
  await mkdir(modules);
  await cp(resolve("node_modules/skills"), join(modules, "skills"), {
    recursive: true,
  });
  await cp(resolve("node_modules/yaml"), join(modules, "yaml"), {
    recursive: true,
  });
  await cp(resolve("node_modules/tar"), join(modules, "tar"), {
    recursive: true,
  });
  const packageFile = join(modules, "skills/package.json");
  const original = JSON.parse(await readFile(packageFile, "utf8"));
  process.env.EQUIP_SKILLS_ROOT = join(modules, "skills");
  const before = await getCompatibility(join(sandbox, "home-a"));
  original.version = "1.7.0-promoted";
  await writeFile(packageFile, JSON.stringify(original));
  const after = await getCompatibility(join(sandbox, "home-a"));
  assert.equal(before.version, "1.7.0");
  assert.equal(after.version, "1.7.0-promoted");
  delete process.env.EQUIP_SKILLS_ROOT;
});

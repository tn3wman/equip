import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAgentProfiles } from "../cli/profiles.ts";
import { synchronize } from "../cli/sync.ts";

test("profile discovery finds conventional and suffixed agent homes", async () => {
  const home = await mkdtemp(join(tmpdir(), "equip-profiles-"));
  await Promise.all([
    mkdir(join(home, ".claude")),
    mkdir(join(home, ".claude_nova")),
    mkdir(join(home, ".claude_nova.lock/skills"), { recursive: true }),
    mkdir(join(home, ".codex")),
    mkdir(join(home, ".codex_purse")),
  ]);

  const profiles = await discoverAgentProfiles({ home, environment: {} });
  assert.deepEqual(
    profiles
      .filter((profile) => ["claude-code", "codex"].includes(profile.id))
      .map(({ id, globalPath, profile, aliases }) => ({
        id,
        globalPath,
        profile,
        aliases,
      })),
    [
      {
        id: "claude-code",
        globalPath: join(home, ".claude/skills"),
        profile: undefined,
        aliases: [
          { profile: "default", path: join(home, ".claude/skills") },
        ],
      },
      {
        id: "claude-code",
        globalPath: join(home, ".claude_nova/skills"),
        profile: "nova",
        aliases: [
          { profile: "nova", path: join(home, ".claude_nova/skills") },
        ],
      },
      {
        id: "codex",
        globalPath: join(home, ".codex/skills"),
        profile: undefined,
        aliases: [
          { profile: "default", path: join(home, ".codex/skills") },
        ],
      },
      {
        id: "codex",
        globalPath: join(home, ".codex_purse/skills"),
        profile: "purse",
        aliases: [
          { profile: "purse", path: join(home, ".codex_purse/skills") },
        ],
      },
    ],
  );
  assert.ok(
    !profiles.some((profile) =>
      profile.globalPath.includes(".claude_nova.lock"),
    ),
  );
});

test("linked skill roots stay one physical target with every configuration alias", async () => {
  const home = await mkdtemp(join(tmpdir(), "equip-profiles-"));
  const primary = join(home, ".codex_purse");
  await mkdir(join(primary, "skills"), { recursive: true });
  await mkdir(join(home, ".codex"));
  await mkdir(join(home, ".codex_nova"));
  await symlink(join(primary, "skills"), join(home, ".codex/skills"));
  await symlink(join(primary, "skills"), join(home, ".codex_nova/skills"));

  const profiles = (await discoverAgentProfiles({
    home,
    environment: { CODEX_HOME: primary },
  })).filter((profile) => profile.id === "codex");
  assert.deepEqual(
    profiles.map(({ globalPath, profile, aliases }) => ({
      globalPath,
      profile,
      aliases,
    })),
    [
      {
        globalPath: join(primary, "skills"),
        profile: undefined,
        aliases: [
          { profile: "purse", path: join(primary, "skills") },
          { profile: "default", path: join(home, ".codex/skills") },
          { profile: "nova", path: join(home, ".codex_nova/skills") },
        ],
      },
    ],
  );
});

test("profile discovery does not mutate process environment", async () => {
  const home = await mkdtemp(join(tmpdir(), "equip-profiles-"));
  await mkdir(join(home, ".codex"));
  const beforeCodex = process.env.CODEX_HOME;
  const beforeClaude = process.env.CLAUDE_CONFIG_DIR;
  await discoverAgentProfiles({
    home,
    environment: { CODEX_HOME: join(home, ".codex") },
  });
  assert.equal(process.env.CODEX_HOME, beforeCodex);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, beforeClaude);
});

test("profile discovery preserves non-profile upstream path overrides", async () => {
  const home = await mkdtemp(join(tmpdir(), "equip-profiles-"));
  const xdg = join(home, "xdg");
  const vibe = join(home, "custom-vibe");
  await mkdir(join(xdg, "opencode"), { recursive: true });
  await mkdir(vibe);
  const profiles = await discoverAgentProfiles({
    home,
    environment: { XDG_CONFIG_HOME: xdg, VIBE_HOME: vibe },
  });
  assert.equal(
    profiles.find((profile) => profile.id === "opencode")?.globalPath,
    join(xdg, "opencode/skills"),
  );
  assert.equal(
    profiles.find((profile) => profile.id === "mistral-vibe")?.globalPath,
    join(vibe, "skills"),
  );
});

test("enabled T3 provider homes outside conventional prefixes are discovered", async () => {
  const home = await mkdtemp(join(tmpdir(), "equip-profiles-"));
  const customCodex = await mkdtemp(join(tmpdir(), "equip-t3-codex-"));
  const disabledClaude = await mkdtemp(join(tmpdir(), "equip-t3-claude-"));
  await mkdir(join(customCodex, "skills"));
  await mkdir(join(disabledClaude, "skills"));
  const settings = join(home, "t3-settings.json");
  await writeFile(
    settings,
    JSON.stringify({
      providerInstances: {
        custom: {
          driver: "codex",
          enabled: true,
          displayName: "Client Work",
          config: { homePath: customCodex, ignoredCredential: "not-read" },
        },
        disabled: {
          driver: "claudeAgent",
          enabled: false,
          displayName: "Disabled",
          config: { homePath: disabledClaude },
        },
        unsupported: {
          driver: "opencode",
          enabled: true,
          displayName: "Unsupported here",
          config: { homePath: join(home, "opencode-custom") },
        },
      },
    }),
  );

  const profiles = await discoverAgentProfiles({
    home,
    environment: {},
    t3SettingsPath: settings,
  });
  const custom = profiles.find(
    (profile) => profile.globalPath === join(customCodex, "skills"),
  );
  assert.equal(custom?.id, "codex");
  assert.equal(custom?.profile, "Client Work");
  assert.deepEqual(custom?.aliases, [
    { profile: "Client Work", path: join(customCodex, "skills") },
  ]);
  assert.ok(
    !profiles.some(
      (profile) => profile.globalPath === join(disabledClaude, "skills"),
    ),
  );
});

test("a deleted profile is absent on the next scan and its clean ledger entry is removed", async () => {
  const home = await mkdtemp(join(tmpdir(), "equip-profiles-"));
  const profileHome = join(home, ".codex_nova");
  const state = join(home, "state");
  await mkdir(profileHome);
  const discovered = (await discoverAgentProfiles({ home, environment: {} }))
    .filter((profile) => profile.id === "codex")
    .map(({ id, globalPath: path, profile }) => ({ id, path, profile }));
  await synchronize(
    {
      generation: 1,
      resolutions: {},
      skills: [
        {
          id: "test-skill",
          name: "demo",
          title: "Demo",
          description: "",
          author: "Test",
          source: "test/source",
          kind: "third-party",
          category: "Test",
          icon: "Sparkles",
          color: "#000000",
          selected: true,
          enabled: true,
          autoUpdate: false,
          revision: "one",
          versions: [],
          files: [{ path: "SKILL.md", content: "managed" }],
          requirements: [],
          targets: [],
          updatedAt: new Date(0).toISOString(),
        },
      ],
    },
    discovered,
    state,
  );
  assert.equal(
    await readFile(join(profileHome, "skills/demo/SKILL.md"), "utf8"),
    "managed",
  );

  await rm(profileHome, { recursive: true });
  const rescanned = (await discoverAgentProfiles({ home, environment: {} }))
    .filter((profile) => profile.id === "codex")
    .map(({ id, globalPath: path, profile }) => ({ id, path, profile }));
  const receipts = await synchronize(
    { generation: 2, resolutions: {}, skills: [] },
    rescanned,
    state,
  );
  assert.equal(rescanned.length, 0);
  assert.equal(receipts[0]?.message, "Released missing installation");
  assert.equal(
    Object.keys(JSON.parse(await readFile(join(state, "ledger.json"), "utf8")).installs)
      .length,
    0,
  );
});

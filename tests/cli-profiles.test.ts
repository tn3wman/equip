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
import { discoverAgentProfiles, discoverConfigurationRoots } from "../cli/profiles.ts";
import { discoverInstructionLocations, synchronizeInstructions } from "../cli/instructions.ts";
import { skillRevision } from "../shared/library.ts";
import type { Instructions } from "../shared/types.ts";
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
  const defaultCodex = profiles.find(profile =>
    profile.id === "codex" && profile.profile === undefined);
  assert.equal(defaultCodex?.detection, "configuration");
  assert.equal(defaultCodex?.detectionPath, join(home, ".codex"));
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
  assert.equal(profiles.find((profile) => profile.id === "opencode")?.detection, "configuration");
  assert.equal(profiles.find((profile) => profile.id === "opencode")?.detectionPath, join(xdg, "opencode/skills"));
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


test("T3 custom data home, default enablement, and provider environment homes drive both discoveries", async t => {
  const home = await mkdtemp(join(tmpdir(), "equip-t3-homes-"));
  t.after(() => rm(home, {recursive:true,force:true}));
  const data = join(home, "t3 custom");
  const roots = ["codex-env", "claude-env", "claude-config", "ignored-env", "disabled"];
  for (const root of roots) await mkdir(join(home, root, "skills"), {recursive:true});
  await mkdir(join(data, "userdata"), {recursive:true});
  await writeFile(join(data,"userdata/settings.json"), JSON.stringify({providerInstances:{
    codex:{driver:"codex", displayName:"Code", config:{homePath:""}, environment:[{name:"CODEX_HOME", value:"~/codex-env"}]},
    claude:{driver:"claudeAgent", enabled:true, displayName:"Chat", environment:[{name:"CLAUDE_CONFIG_DIR", value:"~/claude-env"}]},
    configured:{driver:"claudeAgent", enabled:true, config:{homePath:"~/claude-config"}, environment:[{name:"CLAUDE_CONFIG_DIR", value:"~/ignored-env"}]},
    disabled:{driver:"codex",enabled:false,config:{homePath:"~/disabled"}}
  }}));
  const options={home,environment:{T3CODE_HOME:"~/t3 custom"}};
  const configs = await discoverConfigurationRoots(options);
  const profiles = await discoverAgentProfiles(options);
  for (const [id,root] of [["codex","codex-env"],["claude-code","claude-env"],["claude-code","claude-config"]]) {
    assert.ok(configs.some(c=>c.id===id&&c.root===join(home,root)), root+" instructions");
    assert.ok(profiles.some(c=>c.id===id&&c.globalPath===join(home,root,"skills")),root+" skills");
  }
  for (const root of ["ignored-env","disabled"]) assert.ok(!configs.some(c=>c.root===join(home,root)));
  const override=join(home,"override.json");await writeFile(override,'{}');
  assert.equal((await discoverConfigurationRoots({...options,t3SettingsPath:override})).length,0);
});

test("T3 Codex shared and effective shadow homes get distinct instruction identities and shared skill aliases", async t => {
  const home=await mkdtemp(join(tmpdir(),"equip-t3-shadow-"));t.after(()=>rm(home,{recursive:true,force:true}));
  const shared=join(home,"client-code"),shadow=join(home,"client-auth");
  await mkdir(join(shared,"skills"),{recursive:true});await mkdir(shadow);
  await symlink(join(shared,"skills"),join(shadow,"skills"));
  const settings=join(home,"settings.json");await writeFile(settings,JSON.stringify({providerInstances:{work:{driver:"codex",enabled:true,displayName:"Work",config:{homePath:shared,shadowHomePath:shadow},environment:[{name:"CODEX_HOME",value:join(home,"ignored")} ]}}}));
  const options={home,environment:{},t3SettingsPath:settings};
  const configs=await discoverConfigurationRoots(options);
  assert.ok(configs.some(c=>c.root===shared));assert.ok(configs.some(c=>c.root===shadow));
  assert.equal(new Set(configs.map(c=>c.profile)).size,2,"distinct ledger identities");
  const locations=await discoverInstructionLocations([],options);
  const files=[{path:"AGENTS.md",content:"# Shared T3 policy\n"}];
  const policy:Instructions={id:"t3-policy",title:"Policy",filename:"AGENTS.md",scope:"global",selected:true,enabled:true,revision:skillRevision(files),files,versions:[],targets:[],updatedAt:new Date().toISOString()};
  const state=join(home,"equip-state");
  const receipts=await synchronizeInstructions({generation:1,skills:[],resolutions:{},instructions:[policy]},locations,state);
  assert.equal(receipts.length,2);assert.ok(receipts.every(r=>r.status==='synchronized'));
  for(const root of [shared,shadow]) assert.equal(await readFile(join(root,"AGENTS.md"),"utf8"),files[0].content);
  assert.equal(Object.keys(JSON.parse(await readFile(join(state,"instructions-ledger.json"),"utf8")).installs).length,2);
  const profiles=(await discoverAgentProfiles(options)).filter(p=>p.id==='codex');
  assert.equal(profiles.length,1);assert.deepEqual(profiles[0].aliases?.map(a=>a.path),[join(shared,'skills'),join(shadow,'skills')]);
});


test("empty T3 environment home overrides retain native defaults alongside worker homes", async t => {
  const home=await mkdtemp(join(tmpdir(),"equip-t3-empty-"));t.after(()=>rm(home,{recursive:true,force:true}));
  for(const root of ['.codex','.claude','worker-code','worker-chat']) await mkdir(join(home,root,'skills'),{recursive:true});
  const settings=join(home,'settings.json');await writeFile(settings,JSON.stringify({providerInstances:{
    code:{driver:'codex',environment:[{name:'CODEX_HOME',value:''}]},
    chat:{driver:'claudeAgent',environment:[{name:'CLAUDE_CONFIG_DIR',value:''}]}
  }}));
  const options={home,t3SettingsPath:settings,environment:{CODEX_HOME:join(home,'worker-code'),CLAUDE_CONFIG_DIR:join(home,'worker-chat')}};
  const roots=await discoverConfigurationRoots(options),profiles=await discoverAgentProfiles(options);
  for(const root of ['.codex','.claude','worker-code','worker-chat']) {
    assert.ok(roots.some(r=>r.root===join(home,root)));
    assert.ok(profiles.some(p=>p.globalPath===join(home,root,'skills')));
  }
});

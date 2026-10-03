import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, mkdir, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DesiredState, Skill } from "../shared/types.ts";
import { synchronize } from "../cli/sync.ts";

function skill(content: string, revision = "r1"): Skill {
  return {
    id: "s1",
    name: "demo",
    title: "Demo",
    description: "",
    author: "test",
    source: "test",
    kind: "custom",
    category: "Test",
    icon: "",
    color: "",
    selected: true,
    enabled: true,
    autoUpdate: true,
    revision,
    versions: [],
    files: [
      { path: "SKILL.md", content },
      { path: "scripts/run.sh", content: "#!/bin/sh\n", mode: 0o755 },
    ],
    requirements: [],
    targets: [],
    updatedAt: new Date().toISOString(),
  };
}
const desired = (s: Skill[]): DesiredState => ({
  generation: 1,
  skills: s,
  resolutions: {},
});

test("Nova verifies preexisting linked folders without taking ownership or destroying them", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-nova-links-"));
  const target = join(root, "agent"), shared = join(root, "shared"), home = join(root, "state");
  await synchronize(desired([skill("one")]), [{ id: "codex", path: shared }], join(root, "seed"));
  await mkdir(target);
  await symlink(join(shared, "demo"), join(target, "demo"));
  const linked = { ...skill("one"), librarySourceId: "nova" };
  const receipts = await synchronize(desired([linked]), [{ id: "codex", path: target }], home);
  assert.equal(receipts[0].status, "synchronized");
  assert.equal(receipts[0].managed, false);
  await synchronize(desired([]), [{ id: "codex", path: target }], home);
  assert.equal((await lstat(join(target, "demo"))).isSymbolicLink(), true);
  await writeFile(join(shared, "demo/SKILL.md"), "local work");
  const conflict = await synchronize(desired([linked]), [{ id: "codex", path: target }], home);
  assert.equal(conflict[0].status, "conflicted");
  assert.equal(await readFile(join(shared, "demo/SKILL.md"), "utf8"), "local work");
});

test("identical revision synchronizes to two isolated devices", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const home = join(root, "state");
  const a = join(root, "a");
  const b = join(root, "b");
  const receipts = await synchronize(
    desired([skill("one")]),
    [
      { id: "codex", path: a },
      { id: "claude-code", path: b },
    ],
    home,
  );
  assert.deepEqual(
    receipts.map((r) => r.status),
    ["synchronized", "synchronized"],
  );
  assert.equal(await readFile(join(a, "demo/SKILL.md"), "utf8"), "one");
  assert.equal(await readFile(join(b, "demo/SKILL.md"), "utf8"), "one");
});

test("local edits conflict and preserve the last good install", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const target = join(root, "agent");
  const home = join(root, "state");
  const agent = [{ id: "codex", path: target }];
  await synchronize(desired([skill("one")]), agent, home);
  await writeFile(join(target, "demo/SKILL.md"), "local");
  const receipts = await synchronize(
    { ...desired([skill("two", "r2")]), generation: 2 },
    agent,
    home,
  );
  assert.equal(receipts[0].status, "conflicted");
  assert.equal(await readFile(join(target, "demo/SKILL.md"), "utf8"), "local");
});

test("replace backs up conflicts and removal deletes only unchanged owned installs", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const target = join(root, "agent");
  const home = join(root, "state");
  const agent = [{ id: "codex", path: target }];
  await synchronize(desired([skill("one")]), agent, home);
  await writeFile(join(target, "demo/SKILL.md"), "local");
  await synchronize(
    {
      generation: 2,
      skills: [skill("two", "r2")],
      resolutions: { "s1:codex": "replace" },
    },
    agent,
    home,
  );
  assert.equal(await readFile(join(target, "demo/SKILL.md"), "utf8"), "two");
  await synchronize(
    { generation: 3, skills: [], resolutions: {} },
    agent,
    home,
  );
  await assert.rejects(readFile(join(target, "demo/SKILL.md")));
});

test("active lock prevents concurrent replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const home = join(root, "state");
  await import("node:fs/promises").then((fs) =>
    fs
      .mkdir(home, { recursive: true })
      .then(() =>
        fs.writeFile(
          join(home, "sync.lock"),
          JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
        ),
      ),
  );
  await assert.rejects(
    synchronize(
      desired([skill("one")]),
      [{ id: "codex", path: join(root, "agent") }],
      home,
    ),
    /already running/,
  );
});

test("stale interrupted lock is recovered", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const home = join(root, "state");
  await import("node:fs/promises").then((fs) =>
    fs
      .mkdir(home, { recursive: true })
      .then(() =>
        fs.writeFile(
          join(home, "sync.lock"),
          JSON.stringify({ pid: 999999, createdAt: 1 }),
        ),
      ),
  );
  const receipts = await synchronize(
    desired([skill("one")]),
    [{ id: "codex", path: join(root, "agent") }],
    home,
  );
  assert.equal(receipts[0].status, "synchronized");
});

test("invalid desired path fails without replacing last good files", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const target = join(root, "agent");
  const home = join(root, "state");
  const agent = [{ id: "codex", path: target }];
  await synchronize(desired([skill("good")]), agent, home);
  const bad = skill("bad", "r2");
  bad.files.push({ path: "../escape", content: "bad" });
  const receipts = await synchronize(
    { generation: 2, skills: [bad], resolutions: {} },
    agent,
    home,
  );
  assert.equal(receipts[0].status, "failed");
  assert.match(receipts[0].message ?? "", /Unsafe skill path/);
  assert.equal(await readFile(join(target, "demo/SKILL.md"), "utf8"), "good");
});

test("unowned directories, extra files, removed files, and mode changes conflict with a full snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const target = join(root, "agent");
  const home = join(root, "state");
  const agent = [{ id: "codex", path: target }];
  await import("node:fs/promises").then((fs) =>
    fs
      .mkdir(join(target, "demo"), { recursive: true })
      .then(() =>
        fs.writeFile(
          join(target, "demo/local.bin"),
          Buffer.from([0xff, 0xfe, 2]),
        ),
      ),
  );
  let receipts = await synchronize(desired([skill("server")]), agent, home);
  assert.equal(receipts[0].status, "conflicted");
  assert.equal(receipts[0].localFiles?.[0].encoding, "base64");
  receipts = await synchronize(
    {
      generation: 2,
      skills: [skill("server")],
      resolutions: { "s1:codex": "replace" },
    },
    agent,
    home,
  );
  assert.equal(receipts[0].status, "synchronized");
  await writeFile(join(target, "demo/extra.txt"), "mine");
  await import("node:fs/promises").then(async (fs) => {
    await fs.rm(join(target, "demo/scripts/run.sh"));
    await fs.chmod(join(target, "demo/SKILL.md"), 0o600);
  });
  receipts = await synchronize(
    { generation: 3, skills: [skill("new", "r2")], resolutions: {} },
    agent,
    home,
  );
  assert.equal(receipts[0].status, "conflicted");
  assert.deepEqual(receipts[0].localFiles?.map((f) => f.path).sort(), [
    "SKILL.md",
    "extra.txt",
  ]);
  assert.equal(
    receipts[0].localFiles?.find((f) => f.path === "SKILL.md")?.mode,
    0o600,
  );
});

test("install-time import preserves local directory and releases ownership before exclusion", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const target = join(root, "agent");
  const home = join(root, "state");
  const agent = [{ id: "codex", path: target }];
  await synchronize(desired([skill("server")]), agent, home);
  await writeFile(join(target, "demo/SKILL.md"), "mine");
  let receipts = await synchronize(
    {
      generation: 2,
      skills: [skill("new", "r2")],
      resolutions: { "s1:codex": "import" },
    },
    agent,
    home,
  );
  assert.equal(receipts[0].status, "conflicted");
  assert.equal(await readFile(join(target, "demo/SKILL.md"), "utf8"), "mine");
  assert.equal(
    receipts[0].localFiles?.find((f) => f.path === "SKILL.md")?.content,
    "mine",
  );
  receipts = await synchronize(
    { generation: 3, skills: [], resolutions: {} },
    agent,
    home,
  );
  assert.equal(receipts.length, 0);
  assert.equal(await readFile(join(target, "demo/SKILL.md"), "utf8"), "mine");
});

test("one failed destination does not prevent another target from synchronizing", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const bad = skill("bad");
  bad.name = "../escape";
  const good = skill("good");
  good.id = "s2";
  good.name = "safe";
  const receipts = await synchronize(
    desired([bad, good]),
    [{ id: "codex", path: join(root, "agent") }],
    join(root, "state"),
  );
  assert.deepEqual(
    receipts.map((r) => r.status),
    ["failed", "synchronized"],
  );
  assert.equal(
    await readFile(join(root, "agent/safe/SKILL.md"), "utf8"),
    "good",
  );
});

test("journal recovery restores the last directory before retrying an interrupted replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const target = join(root, "agent");
  const home = join(root, "state");
  const agent = [{ id: "codex", path: target }];
  await synchronize(desired([skill("original")]), agent, home);
  const destination = join(target, "demo");
  const oldPath = `${destination}.equip-old-test`;
  const stage = `${destination}.equip-stage-test`;
  await writeFile(join(destination, "SKILL.md"), "local-before-crash");
  const fs = await import("node:fs/promises");
  await fs.rename(destination, oldPath);
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(join(destination, "SKILL.md"), "half-installed");
  await fs.writeFile(
    join(home, "transaction.json"),
    JSON.stringify({
      destination,
      oldPath,
      stage,
      hadOld: true,
      revision: "r2",
    }),
  );
  const receipts = await synchronize(
    { generation: 2, skills: [skill("new", "r2")], resolutions: {} },
    agent,
    home,
  );
  assert.equal(receipts[0].status, "conflicted");
  assert.equal(
    await readFile(join(destination, "SKILL.md"), "utf8"),
    "local-before-crash",
  );
});

test("a symlinked skill root is conflicted without traversing or replacing its target", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const target = join(root, "agent");
  const external = join(root, "external");
  const fs = await import("node:fs/promises");
  await fs.mkdir(target);
  await fs.mkdir(external);
  await fs.writeFile(join(external, "private.txt"), "untouched");
  await fs.symlink(external, join(target, "demo"));
  const receipts = await synchronize(
    { ...desired([skill("server")]), resolutions: { "s1:codex": "replace" } },
    [{ id: "codex", path: target }],
    join(root, "state"),
  );
  assert.equal(receipts[0].status, "conflicted");
  assert.match(receipts[0].message ?? "", /symbolic link/);
  assert.equal(
    await readFile(join(external, "private.txt"), "utf8"),
    "untouched",
  );
  assert.equal((await fs.lstat(join(target, "demo"))).isSymbolicLink(), true);
});

test("removal resolutions are isolated by profile and release preserved ownership once", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const home = join(root, "state");
  const targets = [
    { id: "codex", profile: "work", path: join(root, "work") },
    { id: "codex", profile: "personal", path: join(root, "personal") },
  ];
  await synchronize(desired([skill("server")]), targets, home);
  await writeFile(join(root, "work/demo/SKILL.md"), "work-local");
  await writeFile(join(root, "personal/demo/SKILL.md"), "personal-local");
  const first = await synchronize(
    { generation: 2, skills: [], resolutions: { "s1:codex:work:": "import" } },
    targets,
    home,
  );
  assert.equal(
    first.find((r) => r.profile === "work")?.message,
    "Imported local files and released management",
  );
  assert.equal(
    first
      .find((r) => r.profile === "work")
      ?.localFiles?.find((f) => f.path === "SKILL.md")?.content,
    "work-local",
  );
  assert.match(
    first.find((r) => r.profile === "personal")?.message ?? "",
    /not removed/,
  );
  const second = await synchronize(
    { generation: 3, skills: [], resolutions: {} },
    targets,
    home,
  );
  assert.equal(
    second.some((r) => r.profile === "work"),
    false,
  );
  assert.equal(second.filter((r) => r.profile === "personal").length, 1);
  assert.equal(
    await readFile(join(root, "work/demo/SKILL.md"), "utf8"),
    "work-local",
  );
});

test("removal import preserves non-UTF8 bytes without NUL as base64", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const target = join(root, "agent");
  const home = join(root, "state");
  const agents = [{ id: "codex", path: target }];
  await synchronize(desired([skill("server")]), agents, home);
  const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
  await writeFile(join(target, "demo/local.bin"), bytes);
  const receipts = await synchronize(
    { generation: 2, skills: [], resolutions: { "s1:codex::": "import" } },
    agents,
    home,
  );
  const file = receipts[0].localFiles?.find(
    (item) => item.path === "local.bin",
  );
  assert.equal(file?.encoding, "base64");
  assert.deepEqual(Buffer.from(file!.content, "base64"), bytes);
  assert.equal(
    await readFile(join(target, "demo/local.bin")).then((data) =>
      data.equals(bytes),
    ),
    true,
  );
});

test("removal replace backs up changed directory and removes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const target = join(root, "agent");
  const home = join(root, "state");
  const agents = [{ id: "codex", path: target }];
  await synchronize(desired([skill("server")]), agents, home);
  await writeFile(join(target, "demo/local.txt"), "local");
  const receipts = await synchronize(
    { generation: 2, skills: [], resolutions: { "s1:codex::": "replace" } },
    agents,
    home,
  );
  assert.equal(receipts[0].status, "synchronized");
  await assert.rejects(readFile(join(target, "demo/SKILL.md")));
  const backups = await import("node:fs/promises").then((fs) =>
    fs.readdir(join(home, "backups")),
  );
  assert.equal(
    await readFile(join(home, "backups", backups[0], "local.txt"), "utf8"),
    "local",
  );
});

test("target rules are per-device overrides while unspecified agents stay enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const configured = skill("one");
  configured.targets = [
    { deviceId: "device-a", agent: "codex", enabled: false },
  ];
  const receipts = await synchronize(
    desired([configured]),
    [
      { id: "codex", path: join(root, "codex"), deviceId: "device-a" },
      { id: "claude-code", path: join(root, "claude"), deviceId: "device-a" },
    ],
    join(root, "state"),
  );
  assert.deepEqual(
    receipts.map((r) => r.agent),
    ["claude-code"],
  );
  await assert.rejects(readFile(join(root, "codex/demo/SKILL.md")));
  assert.equal(
    await readFile(join(root, "claude/demo/SKILL.md"), "utf8"),
    "one",
  );
});

test("a clean managed skill rename moves ownership to the new folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const target = join(root, "agent");
  const home = join(root, "state");
  const agents = [{ id: "codex", path: target }];
  await synchronize(desired([skill("old")]), agents, home);
  const renamed = skill("new", "r2");
  renamed.name = "renamed";
  const receipts = await synchronize(
    { generation: 2, skills: [renamed], resolutions: {} },
    agents,
    home,
  );
  assert.equal(receipts[0].status, "synchronized");
  await assert.rejects(readFile(join(target, "demo/SKILL.md")));
  assert.equal(await readFile(join(target, "renamed/SKILL.md"), "utf8"), "new");
});

test("a managed skill rename preserves a locally modified old folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const target = join(root, "agent");
  const home = join(root, "state");
  const agents = [{ id: "codex", path: target }];
  await synchronize(desired([skill("old")]), agents, home);
  await writeFile(join(target, "demo/SKILL.md"), "local");
  const renamed = skill("new", "r2");
  renamed.name = "renamed";
  const receipts = await synchronize(
    { generation: 2, skills: [renamed], resolutions: {} },
    agents,
    home,
  );
  assert.equal(receipts[0].status, "conflicted");
  assert.equal(receipts[0].path, join(target, "demo"));
  assert.equal(await readFile(join(target, "demo/SKILL.md"), "utf8"), "local");
  await assert.rejects(readFile(join(target, "renamed/SKILL.md")));
});

test("rename import releases modified old ownership before exclusion", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const target = join(root, "agent");
  const home = join(root, "state");
  const agents = [{ id: "codex", path: target }];
  await synchronize(desired([skill("old")]), agents, home);
  await writeFile(join(target, "demo/SKILL.md"), "local");
  const renamed = skill("new", "r2");
  renamed.name = "renamed";
  const first = await synchronize(
    {
      generation: 2,
      skills: [renamed],
      resolutions: { "s1:codex::": "import" },
    },
    agents,
    home,
  );
  assert.equal(first[0].status, "conflicted");
  assert.equal(
    first[0].localFiles?.find((file) => file.path === "SKILL.md")?.content,
    "local",
  );
  const second = await synchronize(
    { generation: 3, skills: [], resolutions: {} },
    agents,
    home,
  );
  assert.equal(second.length, 0);
  assert.equal(await readFile(join(target, "demo/SKILL.md"), "utf8"), "local");
});

test("rename replace backs up modified old and occupied new folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const target = join(root, "agent");
  const home = join(root, "state");
  const agents = [{ id: "codex", path: target }];
  await synchronize(desired([skill("old")]), agents, home);
  await writeFile(join(target, "demo/local.txt"), "old-local");
  const fs = await import("node:fs/promises");
  await fs.mkdir(join(target, "renamed"));
  await writeFile(join(target, "renamed/local.txt"), "new-local");
  const renamed = skill("server", "r2");
  renamed.name = "renamed";
  const receipts = await synchronize(
    {
      generation: 2,
      skills: [renamed],
      resolutions: { "s1:codex::": "replace" },
    },
    agents,
    home,
  );
  assert.equal(receipts[0].status, "synchronized");
  await assert.rejects(readFile(join(target, "demo/SKILL.md")));
  assert.equal(
    await readFile(join(target, "renamed/SKILL.md"), "utf8"),
    "server",
  );
  const backups = await fs.readdir(join(home, "backups"));
  const contents = await Promise.all(
    backups.map(async (folder) =>
      readFile(join(home, "backups", folder, "local.txt"), "utf8").catch(
        () => "",
      ),
    ),
  );
  assert.deepEqual(contents.sort(), ["new-local", "old-local"]);
});

test("an unchanged revision leaves the installed directory in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-test-"));
  const target = join(root, "agent");
  const home = join(root, "state");
  const agents = [{ id: "codex", path: target }];
  const value = skill("same");
  await synchronize(desired([value]), agents, home);
  const before = await stat(join(target, "demo"));
  await synchronize(
    { generation: 2, skills: [value], resolutions: {} },
    agents,
    home,
  );
  const after = await stat(join(target, "demo"));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

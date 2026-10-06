import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Skill, Workspace } from "../shared/types.ts";
import { openStore } from "../server/storage.ts";
import { migrateWorkspaces, readWorkspace, readWorkspaceWithOptions, writeWorkspace } from "../server/workspace-store.ts";

const files = (name: string, body: string) => [{
  path: "SKILL.md",
  content: `---\nname: ${name}\ndescription: Test ${name}\n---\n\n${body}\n`,
}];

function workspace(name: string, skillName: string): Workspace {
  const current = files(skillName, "Current");
  const previous = files(skillName, "Previous");
  const skill: Skill = {
    id: `skill-${skillName}`, name: skillName, title: skillName, description: `Test ${skillName}`,
    author: name, source: "custom", kind: "custom", category: "Test", icon: "code", color: "#000",
    selected: true, enabled: true, autoUpdate: false, revision: "current", files: current,
    draft: files(skillName, "Draft"), requirements: [], targets: [], updatedAt: new Date(0).toISOString(),
    versions: [
      { id: "current", revision: "current", createdAt: new Date(1).toISOString(), message: "Published", files: current },
      { id: "previous", revision: "previous", createdAt: new Date(0).toISOString(), message: "Published", files: previous },
    ],
  };
  return {
    name, email: `${name}@example.test`, demo: false, skills: [skill], instructions: [],
    devices: [{ id: `device-${name}`, name: `${name} laptop`, os: "linux", arch: "x64", online: true,
      lastSeen: new Date(0).toISOString(), agents: [], receipts: [] }], activity: [], generation: 1,
  };
}

test("workspace migration hydrates bundles and devices through publish and rollback state", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "equip-workspace-store-"));
  const store = await openStore({ dataDir });
  try {
    const original = workspace("owner", "review");
    await store.run("INSERT INTO accounts(id,name,email,password_hash,workspace,created_at) VALUES(?,?,?,?,?,?)",
      "owner", original.name, original.email, "hash", JSON.stringify(original), new Date(0).toISOString());
    await migrateWorkspaces(store);

    const migratedRow = (await store.get<{ workspace: string }>("SELECT workspace FROM accounts WHERE id=?", "owner"))!;
    const stored = JSON.parse(migratedRow.workspace);
    assert.equal(stored.storageVersion, 1);
    assert.deepEqual(stored.devices, []);
    assert.equal(stored.skills[0].files.length, 0);
    assert.match(stored.skills[0].filesBundle, /^[a-f0-9]{64}$/);

    const hydrated = JSON.parse(await readWorkspace(store, "owner", migratedRow.workspace)) as Workspace;
    assert.deepEqual(hydrated, original);

    const skill = hydrated.skills[0];
    const published = files(skill.name, "New publication");
    skill.files = published;
    skill.revision = "new";
    skill.versions.unshift({ id: "new", revision: "new", createdAt: new Date(1).toISOString(), message: "Published", files: published });
    await writeWorkspace(store, "owner", hydrated);

    const publishedRow = (await store.get<{ workspace: string }>("SELECT workspace FROM accounts WHERE id=?", "owner"))!;
    const afterPublish = JSON.parse(await readWorkspace(store, "owner", publishedRow.workspace)) as Workspace;
    afterPublish.skills[0].files = structuredClone(afterPublish.skills[0].versions[1].files);
    afterPublish.skills[0].revision = afterPublish.skills[0].versions[1].revision;
    await writeWorkspace(store, "owner", afterPublish);

    const rollbackRow = (await store.get<{ workspace: string }>("SELECT workspace FROM accounts WHERE id=?", "owner"))!;
    const rolledBack = JSON.parse(await readWorkspace(store, "owner", rollbackRow.workspace)) as Workspace;
    assert.equal(rolledBack.skills[0].revision, "current");
    assert.deepEqual(rolledBack.skills[0].files, original.skills[0].files);
    assert.deepEqual(rolledBack.devices, original.devices);
    assert.deepEqual(rolledBack.skills[0].draft, original.skills[0].draft);
  } finally {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("identical bundle hashes remain account scoped", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "equip-workspace-accounts-"));
  const store = await openStore({ dataDir });
  try {
    const first = workspace("first", "shared");
    const second = { ...workspace("second", "shared"), skills: structuredClone(first.skills) };
    for (const [id, value] of [["first", first], ["second", second]] as const)
      await store.run("INSERT INTO accounts(id,name,email,password_hash,workspace,created_at) VALUES(?,?,?,?,?,?)",
        id, value.name, value.email, "hash", JSON.stringify(value), new Date(0).toISOString());
    await migrateWorkspaces(store);
    const bundles = await store.all<{ account_id: string; hash: string }>("SELECT account_id,hash FROM skill_bundles ORDER BY account_id,hash");
    assert.ok(bundles.some(row => row.account_id === "first"));
    assert.ok(bundles.some(row => row.account_id === "second"));
    await store.run("DELETE FROM skill_bundles WHERE account_id=?", "first");
    const secondRow = (await store.get<{ workspace: string }>("SELECT workspace FROM accounts WHERE id=?", "second"))!;
    const hydrated = JSON.parse(await readWorkspace(store, "second", secondRow.workspace)) as Workspace;
    assert.deepEqual(hydrated.skills[0].files, first.skills[0].files);
  } finally {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("workspace versions advance only when metadata or devices change", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "equip-workspace-version-"));
  const store = await openStore({ dataDir });
  try {
    const original = workspace("owner", "review");
    await store.run("INSERT INTO accounts(id,name,email,password_hash,workspace,created_at) VALUES(?,?,?,?,?,?)",
      "owner", original.name, original.email, "hash", JSON.stringify(original), new Date(0).toISOString());
    await migrateWorkspaces(store);
    const migrated = (await store.get<{ workspace: string; version: number }>("SELECT workspace,version FROM accounts WHERE id=?", "owner"))!;
    assert.equal(migrated.version, 1);
    const hydrated = JSON.parse(await readWorkspace(store, "owner", migrated.workspace)) as Workspace;

    await writeWorkspace(store, "owner", hydrated);
    assert.equal((await store.get<{ version: number }>("SELECT version FROM accounts WHERE id=?", "owner"))!.version, 1);

    hydrated.skills[0].kind = "third-party";
    hydrated.skills[0].autoUpdate = true;
    await writeWorkspace(store, "owner", hydrated);
    assert.deepEqual(
      await store.get("SELECT version,auto_updates FROM accounts WHERE id=?", "owner"),
      { version: 2, auto_updates: 1 },
    );

    hydrated.devices[0].name = "Renamed laptop";
    await writeWorkspace(store, "owner", hydrated);
    const changedDevice = (await store.get<{ version: number; desired_version: number }>("SELECT version,desired_version FROM workspace_devices WHERE account_id=? AND device_id=?", "owner", hydrated.devices[0].id))!;
    assert.deepEqual(changedDevice, { version: 2, desired_version: 2 });
    assert.equal((await store.get<{ version: number }>("SELECT version FROM accounts WHERE id=?", "owner"))!.version, 3);

    hydrated.generation += 1;
    await writeWorkspace(store, "owner", hydrated);
    assert.equal((await store.get<{ version: number }>("SELECT version FROM accounts WHERE id=?", "owner"))!.version, 4);
  } finally {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("selective hydration skips devices and history while preserving bundle references", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "equip-workspace-selective-"));
  const store = await openStore({ dataDir });
  try {
    const original = workspace("owner", "review");
    const disabled = { ...structuredClone(original.skills[0]), id: "disabled", name: "disabled", selected: false };
    disabled.files = files("disabled", "Disabled current");
    original.skills.push(disabled);
    const retired = { ...structuredClone(original.skills[0]), id: "retired", name: "retired", selected: true, enabled: true };
    retired.files = files("retired", "Retired current");
    original.retiredSkills = [retired];
    await store.run("INSERT INTO accounts(id,name,email,password_hash,workspace,created_at) VALUES(?,?,?,?,?,?)",
      "owner", original.name, original.email, "hash", JSON.stringify(original), new Date(0).toISOString());
    await migrateWorkspaces(store);
    const row = (await store.get<{ workspace: string }>("SELECT workspace FROM accounts WHERE id=?", "owner"))!;
    const stored = JSON.parse(row.workspace);
    const currentHash = stored.skills[0].filesBundle;
    const historyHash = stored.skills[0].versions[1].filesBundle;
    const disabledHash = stored.skills[1].filesBundle;
    const draftHash = stored.skills[0].draftBundle;
    const retiredHash = stored.retiredSkills[0].filesBundle;
    await store.run(`DELETE FROM skill_bundles WHERE account_id=? AND hash IN (?,?,?,?)`, "owner", historyHash, disabledHash, draftHash, retiredHash);

    const hydrated = JSON.parse(await readWorkspaceWithOptions(store, "owner", row.workspace, {
      devices: false,
      bundles: "desired",
      preserveReferences: true,
    }));
    assert.deepEqual(hydrated.devices, []);
    assert.equal(hydrated.skills[0].files[0].content, original.skills[0].files[0].content);
    assert.equal(hydrated.skills[0].filesBundle, currentHash);
    assert.deepEqual(hydrated.skills[0].draft, []);
    assert.equal(hydrated.skills[0].draftBundle, draftHash);
    assert.deepEqual(hydrated.skills[0].versions[1].files, []);
    assert.equal(hydrated.skills[0].versions[1].filesBundle, historyHash);
    assert.deepEqual(hydrated.skills[1].files, []);
    assert.equal(hydrated.skills[1].filesBundle, disabledHash);
    assert.deepEqual(hydrated.retiredSkills[0].files, []);
    assert.equal(hydrated.retiredSkills[0].filesBundle, retiredHash);
  } finally {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("workspace writes collect only account-scoped bundles that no saved state references", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "equip-workspace-bundle-gc-"));
  const store = await openStore({ dataDir });
  try {
    const owner = workspace("owner", "review");
    const other = { ...workspace("other", "review"), skills: structuredClone(owner.skills) };
    for (const [id, value] of [["owner", owner], ["other", other]] as const)
      await store.run("INSERT INTO accounts(id,name,email,password_hash,workspace,created_at) VALUES(?,?,?,?,?,?)",
        id, value.name, value.email, "hash", JSON.stringify(value), new Date(0).toISOString());
    await migrateWorkspaces(store);

    const ownerRow = (await store.get<{ workspace: string }>("SELECT workspace FROM accounts WHERE id=?", "owner"))!;
    const stored = JSON.parse(ownerRow.workspace);
    const oldDraft = stored.skills[0].draftBundle as string;
    const history = stored.skills[0].versions.map((version: any) => version.filesBundle as string);
    assert.ok(await store.get("SELECT hash FROM skill_bundles WHERE account_id=? AND hash=?", "owner", oldDraft));
    assert.ok(await store.get("SELECT hash FROM skill_bundles WHERE account_id=? AND hash=?", "other", oldDraft));

    const hydrated = JSON.parse(await readWorkspace(store, "owner", ownerRow.workspace)) as Workspace;
    hydrated.skills[0].draft = files("review", "Replacement draft");
    await writeWorkspace(store, "owner", hydrated);

    assert.equal(await store.get("SELECT hash FROM skill_bundles WHERE account_id=? AND hash=?", "owner", oldDraft), undefined);
    for (const hash of history)
      assert.ok(await store.get("SELECT hash FROM skill_bundles WHERE account_id=? AND hash=?", "owner", hash));
    assert.ok(await store.get("SELECT hash FROM skill_bundles WHERE account_id=? AND hash=?", "other", oldDraft));
  } finally {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

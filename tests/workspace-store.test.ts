import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Skill, Workspace } from "../shared/types.ts";
import { openStore } from "../server/storage.ts";
import { migrateWorkspaces, readWorkspace, writeWorkspace } from "../server/workspace-store.ts";

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

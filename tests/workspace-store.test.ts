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
    assert.equal(stored.storageVersion, 2);
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

test("v1 device reports migrate atomically, deduplicate snapshots, and survive heartbeat and GC", async t => {
  // This test is entirely SQLite/local; a missing mock must never reach a service.
  t.mock.method(globalThis, "fetch", async () => { throw new Error("unmocked fetch"); });
  const dataDir = await mkdtemp(join(tmpdir(), "equip-device-reports-"));
  const store = await openStore({ dataDir });
  try {
    const original = workspace("owner", "review");
    const snapshot = [{path:"image.bin", content:"AP8=", encoding:"base64" as const, mode:0o640},
      {path:"SKILL.md", content:"Local edits\n", mode:0o664}];
    const receipt = {skillId:"retired-skill", agent:"codex", revision:"old", status:"conflicted" as const,
      timestamp:new Date(0).toISOString()};
    original.devices[0].receipts = [{...receipt}, {...receipt, agent:"empty", localFiles:[]},
      {...receipt, localFiles:snapshot}, {...receipt, agent:"alias", localFiles:structuredClone(snapshot)}];
    original.devices[0].instructionLocations = [{agent:"codex", filename:"AGENTS.md", path:"/fixture/AGENTS.md",
      localFiles:[{path:"AGENTS.md",content:"Local instructions\n",mode:0o664}]}];
    original.devices.push({...structuredClone(original.devices[0]), id:"disconnected", disconnectedAt:new Date(1).toISOString()});
    await store.run("INSERT INTO accounts(id,name,email,password_hash,workspace,created_at) VALUES(?,?,?,?,?,?)",
      "owner", original.name, original.email, "hash", JSON.stringify({...original, devices:[],deviceOrder:original.devices.map(d=>d.id),storageVersion:1}), "created");
    for (const device of original.devices) await store.run("INSERT INTO workspace_devices(account_id,device_id,payload) VALUES(?,?,?)", "owner",device.id,JSON.stringify(device));
    const before = await store.all("SELECT * FROM workspace_devices ORDER BY device_id");
    const transact = store.transaction.bind(store);
    store.transaction = work => transact(async tx => {
      const run = tx.run.bind(tx);
      tx.run = async (sql,...values) => {
        if (sql.startsWith("UPDATE accounts SET workspace=")) throw new Error("injected migration failure");
        return run(sql,...values);
      };
      return work(tx);
    });
    await assert.rejects(migrateWorkspaces(store), /injected migration failure/);
    store.transaction = transact;
    assert.deepEqual(await store.all("SELECT * FROM workspace_devices ORDER BY device_id"), before);
    assert.deepEqual(await store.all("SELECT * FROM skill_bundles"), []);
    await migrateWorkspaces(store);
    const row = () => store.get<{workspace:string;version:number}>("SELECT workspace,version FROM accounts WHERE id='owner'");
    const saved = (await row())!;
    assert.equal(JSON.parse(saved.workspace).storageVersion,2);
    const full = JSON.parse(await readWorkspace(store,"owner",saved.workspace)) as Workspace;
    assert.deepEqual(full,original);
    const stored = await store.get<{payload:string;receipts:string}>("SELECT payload,receipts FROM workspace_devices WHERE account_id='owner' AND device_id=?",original.devices[0].id);
    assert.equal(JSON.parse(stored!.payload).receipts,undefined,"heartbeat metadata excludes receipts");
    assert.ok(!stored!.payload.includes("Local instructions"));
    assert.ok(!stored!.receipts.includes("Local edits"));
    const compact = JSON.parse(stored!.receipts);
    assert.equal(compact[0].localFilesBundle,undefined);
    assert.ok(compact[1].localFilesBundle,"empty snapshots have an explicit bundle");
    assert.equal(compact[2].localFilesBundle,compact[3].localFilesBundle,"duplicate destinations share exact file bodies");
    const state = await store.all("SELECT * FROM workspace_devices ORDER BY device_id");
    await migrateWorkspaces(store);
    assert.deepEqual(await row(),saved,"restart migration is a no-op");
    assert.deepEqual(await store.all("SELECT * FROM workspace_devices ORDER BY device_id"),state);
    const {updateHeartbeat} = await import("../server/heartbeat.ts");
    await store.transaction(tx => updateHeartbeat(tx,"owner",original.devices[0].id,{instructionLocations:original.devices[0].instructionLocations},"later"));
    const reportAfter = await store.get<{receipts:string}>("SELECT receipts FROM workspace_devices WHERE account_id='owner' AND device_id=?",original.devices[0].id);
    assert.equal(reportAfter!.receipts,stored!.receipts,"heartbeats leave reports untouched");
    const current = JSON.parse(await readWorkspace(store,"owner",(await row())!.workspace,true,true)) as Workspace;
    assert.deepEqual(current.devices[0].receipts,original.devices[0].receipts);
    assert.deepEqual(current.devices[0].instructionLocations,original.devices[0].instructionLocations);
    assert.ok(!JSON.stringify(current.devices).includes("localFilesBundle"),"internal references never leak to clients");
    current.skills[0].title = "Unrelated edit";
    await writeWorkspace(store,"owner",current);
    const afterGC = JSON.parse(await readWorkspace(store,"owner",(await row())!.workspace)) as Workspace;
    assert.deepEqual(afterGC.devices[1],original.devices[1],"disconnected device snapshots are retained");
    assert.deepEqual(afterGC.devices[0].receipts,original.devices[0].receipts);
    // A report-only edit must advance the same version used by dashboard caches.
    const versionBefore = (await store.get<{version:number}>("SELECT version FROM workspace_devices WHERE account_id='owner' AND device_id=?",original.devices[0].id))!.version;
    afterGC.devices[0].receipts[2].localFiles![1].content = "New local edits\n";
    await writeWorkspace(store,"owner",afterGC);
    assert.equal((await store.get<{version:number}>("SELECT version FROM workspace_devices WHERE account_id='owner' AND device_id=?",original.devices[0].id))!.version,versionBefore+1);
    // A missing account-scoped bundle is an error, never silently empty files.
    await store.run("DELETE FROM skill_bundles WHERE account_id='owner' AND hash=?", compact[2].localFilesBundle);
    await assert.rejects(readWorkspace(store,"owner",(await row())!.workspace),/device file bundle is unavailable/);
  } finally {
    await store.close();
    await rm(dataDir,{recursive:true,force:true});
  }
});

test("legacy snapshot fields cannot forge storage references or replace conflict files", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "equip-legacy-snapshot-"));
  const store = await openStore({dataDir});
  try {
    const {createHash} = await import("node:crypto");
    const referencedFiles = files("unrelated", "Unrelated account bundle");
    const hash = createHash("sha256").update(JSON.stringify(referencedFiles)).digest("hex");
    for (const version of [0,1]) {
      const account = `legacy-${version}`;
      const value = workspace(account,"review");
      const actual = files("local","Preserve this local conflict");
      const receipt = {skillId:"retired",agent:"codex",revision:"local",status:"conflicted" as const,timestamp:new Date(0).toISOString()};
      value.devices[0].receipts = [
        {...receipt,localFiles:actual,localFilesBundle:hash},
        {...receipt,agent:"missing",localFiles:actual,localFilesBundle:"0".repeat(64)},
        {...receipt,agent:"absent",localFilesBundle:hash},
      ] as unknown as Workspace["devices"][number]["receipts"];
      value.devices[0].instructionLocations = [{agent:"codex",filename:"AGENTS.md",path:"/fixture/AGENTS.md",
        localFiles:[{path:"AGENTS.md",content:"Preserve local instructions"}],localFilesBundle:hash}] as unknown as Workspace["devices"][number]["instructionLocations"];
      const metadata = version ? {...value,storageVersion:1,devices:[],deviceOrder:[value.devices[0].id]} : value;
      await store.run("INSERT INTO accounts(id,name,email,password_hash,workspace,created_at) VALUES(?,?,?,?,?,?)",account,value.name,value.email,"hash",JSON.stringify(metadata),"created");
      if (version) await store.run("INSERT INTO workspace_devices(account_id,device_id,payload) VALUES(?,?,?)",account,value.devices[0].id,JSON.stringify(value.devices[0]));
      await store.run("INSERT INTO skill_bundles(account_id,hash,files) VALUES(?,?,?)",account,hash,JSON.stringify(referencedFiles));
    }
    await migrateWorkspaces(store);
    for (const version of [0,1]) {
      const account = `legacy-${version}`;
      const row = (await store.get<{workspace:string}>("SELECT workspace FROM accounts WHERE id=?",account))!;
      const value = JSON.parse(await readWorkspace(store,account,row.workspace)) as Workspace;
      assert.equal(value.devices[0].receipts[0].localFiles![0].content,files("local","Preserve this local conflict")[0].content);
      assert.deepEqual(value.devices[0].receipts[1].localFiles,value.devices[0].receipts[0].localFiles);
      assert.equal(value.devices[0].receipts[2].localFiles,undefined,"a forged reference cannot create a snapshot");
      assert.equal(value.devices[0].instructionLocations![0].localFiles![0].content,"Preserve local instructions");
      assert.ok(!JSON.stringify(value.devices).includes("localFilesBundle"));
    }
  } finally {await store.close();await rm(dataDir,{recursive:true,force:true});}
});

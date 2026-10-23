import { createHash } from "node:crypto";
import type { Device, SkillFile, Workspace } from "../shared/types.ts";
import type { Store } from "./storage.ts";
import { packDeviceFiles, deviceFileReferences, saveFileBundles, hydrateDeviceFiles, discardDeviceFileReferences } from "./device-files.ts";

type StoredFiles = { files: SkillFile[]; filesBundle?: string; draft?: SkillFile[]; draftBundle?: string };

/** Bundles are immutable and account-scoped. Heartbeats update device rows only. */
export async function writeWorkspace(store: Store, accountId: string, workspace: Workspace) {
  const metadata = structuredClone(workspace) as Workspace & { storageVersion?: number; deviceOrder?: string[] };
  const bundles = new Map<string, string>();
  const pack = (owner: StoredFiles) => {
    for (const field of ["files", "draft"] as const) {
      const files = owner[field];
      const reference = field === "files" ? "filesBundle" : "draftBundle";
      if (files === undefined) { delete owner[reference]; continue; }
      if (files.length || !owner[reference]) {
        const value = JSON.stringify(files);
        const hash = createHash("sha256").update(value).digest("hex");
        bundles.set(hash, value);
        owner[reference] = hash;
      }
      owner[field] = [];
    }
  };
  for (const item of [...metadata.skills, ...(metadata.instructions ?? []), ...(metadata.retiredSkills ?? []), ...(metadata.retiredInstructions ?? [])]) {
    pack(item);
    item.versions.forEach(pack);
    if ("proposal" in item && item.proposal) pack(item.proposal);
  }
  for (const device of metadata.devices) packDeviceFiles(device, bundles);
  await saveFileBundles(store, accountId, bundles);
  const deviceRows: unknown[] = [];
  for (const device of metadata.devices) {
    const { receipts, ...details } = device;
    deviceRows.push(accountId, device.id, JSON.stringify(details), JSON.stringify(receipts), device.lastSeen ?? "", device.disconnectedAt ? 1 : 0);
  }
  let devicesChanged = 0;
  if (deviceRows.length) {
    const payloadChanged = store.dialect === "postgres"
      ? "workspace_devices.payload::jsonb IS DISTINCT FROM excluded.payload::jsonb OR workspace_devices.receipts<>excluded.receipts"
      : "workspace_devices.payload<>excluded.payload OR workspace_devices.receipts<>excluded.receipts";
    const result = await store.run(
      `INSERT INTO workspace_devices(account_id,device_id,payload,receipts,version,desired_version,last_seen,disconnected) VALUES ${metadata.devices.map(() => "(?,?,?,?,1,1,?,?)").join(",")} ON CONFLICT(account_id,device_id) DO UPDATE SET payload=excluded.payload,receipts=excluded.receipts,version=workspace_devices.version+1,desired_version=workspace_devices.desired_version+1,last_seen=excluded.last_seen,disconnected=excluded.disconnected WHERE ${payloadChanged}`,
      ...deviceRows,
    );
    devicesChanged += result.changes;
  }
  const ids = metadata.devices.map(device => device.id);
  const deleted = ids.length
    ? await store.run(`DELETE FROM workspace_devices WHERE account_id=? AND device_id NOT IN (${ids.map(() => "?").join(",")})`, accountId, ...ids)
    : await store.run("DELETE FROM workspace_devices WHERE account_id=?", accountId);
  devicesChanged += deleted.changes;
  metadata.deviceOrder = metadata.devices.map(device => device.id);
  const deviceBundles = metadata.devices.flatMap(deviceFileReferences);
  metadata.devices = [];
  metadata.storageVersion = 2;
  const value = JSON.stringify(metadata);
  const autoUpdates = metadata.skills.some(skill => skill.kind === "third-party" && skill.autoUpdate) ? 1 : 0;
  if (devicesChanged)
    await store.run("UPDATE accounts SET workspace=?,auto_updates=?,version=version+1 WHERE id=?", value, autoUpdates, accountId);
  else
    await store.run("UPDATE accounts SET workspace=?,auto_updates=?,version=version+1 WHERE id=? AND (workspace<>? OR auto_updates<>?)", value, autoUpdates, accountId, value, autoUpdates);

  const referencedBundles = new Set(deviceBundles);
  for (const item of [...metadata.skills, ...(metadata.instructions ?? []), ...(metadata.retiredSkills ?? []), ...(metadata.retiredInstructions ?? [])]) {
    const owners = [item, ...item.versions, ...("proposal" in item && item.proposal ? [item.proposal] : [])] as StoredFiles[];
    for (const owner of owners) {
      if (owner.filesBundle) referencedBundles.add(owner.filesBundle);
      if (owner.draftBundle) referencedBundles.add(owner.draftBundle);
    }
  }
  const references = JSON.stringify([...referencedBundles]);
  if (store.dialect === "postgres")
    await store.run("DELETE FROM skill_bundles WHERE account_id=? AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(?::jsonb) AS ref(hash) WHERE ref.hash=skill_bundles.hash)", accountId, references);
  else
    await store.run("DELETE FROM skill_bundles WHERE account_id=? AND NOT EXISTS (SELECT 1 FROM json_each(?) ref WHERE ref.value=skill_bundles.hash)", accountId, references);
}

export interface ReadWorkspaceOptions {
  devices?: boolean;
  bundles?: "all" | "dashboard" | "desired";
  preserveReferences?: boolean;
}

export async function readWorkspaceWithOptions(store: Store, accountId: string, value: string, options: ReadWorkspaceOptions = {}): Promise<string> {
  const { devices = true, bundles: bundleMode = "all", preserveReferences = false } = options;
  const workspace = JSON.parse(value) as Workspace & { storageVersion?: number; deviceOrder?: string[] };
  if ((workspace.storageVersion === 1 || workspace.storageVersion === 2) && devices) {
    const rows = await store.all<{payload:string;receipts:string}>("SELECT payload,receipts FROM workspace_devices WHERE account_id=? ORDER BY device_id", accountId);
    const byId = new Map(rows.map(row => { const device = JSON.parse(row.payload) as Device; device.receipts ??= JSON.parse(row.receipts); return [device.id, device] as const; }));
    workspace.devices = (workspace.deviceOrder ?? [...byId.keys()]).flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  }
  if (devices) {
    // Legacy receipt APIs accepted extra fields. Only v2 references were created
    // by this storage layer; legacy inline files must always win over such fields.
    if (workspace.storageVersion === 2) await hydrateDeviceFiles(store, accountId, workspace.devices);
    else discardDeviceFileReferences(workspace.devices);
  }
  const needed = new Set<string>();
  const activeItems = [...workspace.skills, ...(workspace.instructions ?? [])];
  const allItems = [...activeItems, ...(workspace.retiredSkills ?? []), ...(workspace.retiredInstructions ?? [])];
  for (const item of allItems) {
    const owners: StoredFiles[] = bundleMode === "all" ? [item, ...item.versions] : [];
    // Selective reads load only the current published content.
    if (bundleMode === "dashboard" && (workspace.instructions ?? []).includes(item as any) && item.revision) owners.push(item);
    if (bundleMode === "desired" && activeItems.includes(item) && item.selected && item.enabled && item.revision) owners.push(item);
    if (bundleMode === "all" && "proposal" in item && item.proposal) owners.push(item.proposal);
    for (const owner of owners) {
      if (owner.filesBundle) needed.add(owner.filesBundle);
      if (bundleMode === "all" && owner.draftBundle) needed.add(owner.draftBundle);
    }
  }
  const bundles = new Map<string, SkillFile[]>();
  if (needed.size) {
    const hashes = [...needed];
    const rows = await store.all<{hash:string;files:string}>(`SELECT hash,files FROM skill_bundles WHERE account_id=? AND hash IN (${hashes.map(() => "?").join(",")})`, accountId, ...hashes);
    for (const row of rows) bundles.set(row.hash, JSON.parse(row.files));
    for (const hash of hashes) if (!bundles.has(hash)) throw new Error("A saved skill bundle is unavailable.");
  }
  for (const item of [...workspace.skills, ...(workspace.instructions ?? []), ...(workspace.retiredSkills ?? []), ...(workspace.retiredInstructions ?? [])]) {
    for (const owner of [item, ...item.versions, ...("proposal" in item && item.proposal ? [item.proposal] : [])] as StoredFiles[]) {
      for (const field of ["files", "draft"] as const) {
        const reference = field === "files" ? "filesBundle" : "draftBundle";
        const hash = owner[reference];
        if (hash && bundles.has(hash)) owner[field] = structuredClone(bundles.get(hash)!);
        if (!preserveReferences) delete owner[reference];
      }
    }
  }
  delete workspace.storageVersion;
  delete workspace.deviceOrder;
  return JSON.stringify(workspace);
}

export async function readWorkspace(store: Store, accountId: string, value: string, dashboard = false, preserveReferences = false): Promise<string> {
  return readWorkspaceWithOptions(store, accountId, value, {
    bundles: dashboard ? "dashboard" : "all",
    preserveReferences,
  });
}

export async function migrateWorkspaces(store: Store) {
  // Lock and migrate one account at a time; never load every device blob at once.
  const predicate = store.dialect === "postgres"
    ? "COALESCE(workspace::jsonb->>'storageVersion','0') IN ('0','1') AND jsonb_typeof(workspace::jsonb->'skills')='array' AND jsonb_typeof(workspace::jsonb->'devices')='array'"
    : "COALESCE(json_extract(workspace,'$.storageVersion'),0) IN (0,1) AND json_type(workspace,'$.skills')='array' AND json_type(workspace,'$.devices')='array'";
  const accounts = await store.all<{id:string}>(`SELECT id FROM accounts WHERE ${predicate}`);
  for (const account of accounts) await store.transaction(async transaction => {
    const row = await transaction.get<{workspace:string}>(`SELECT workspace FROM accounts WHERE id=?${transaction.dialect === "postgres" ? " FOR UPDATE" : ""}`, account.id);
    if (!row) return;
    const saved = JSON.parse(row.workspace);
    if (saved.storageVersion === 2) return;
    // Keep published/history bundle references; only device snapshots need bodies.
    const value = JSON.parse(await readWorkspaceWithOptions(transaction, account.id, row.workspace, { bundles: "dashboard", preserveReferences: true }));
    await writeWorkspace(transaction, account.id, value);
  });
}

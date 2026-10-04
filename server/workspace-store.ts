import { createHash } from "node:crypto";
import type { Device, SkillFile, Workspace } from "../shared/types.ts";
import type { Store } from "./storage.ts";

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
  const entries = [...bundles];
  for (let offset = 0; offset < entries.length; offset += 200) {
    const batch = entries.slice(offset, offset + 200);
    await store.run(`INSERT INTO skill_bundles(account_id,hash,files) VALUES ${batch.map(() => "(?,?,?)").join(",")} ON CONFLICT DO NOTHING`, ...batch.flatMap(([hash,files]) => [accountId,hash,files]));
  }
  const deviceRows: unknown[] = [];
  for (const device of metadata.devices) {
    const payload = JSON.stringify(device);
    deviceRows.push(accountId, device.id, payload);
  }
  if (deviceRows.length) await store.run(`INSERT INTO workspace_devices(account_id,device_id,payload) VALUES ${metadata.devices.map(() => "(?,?,?)").join(",")} ON CONFLICT(account_id,device_id) DO UPDATE SET payload=excluded.payload WHERE workspace_devices.payload<>excluded.payload`, ...deviceRows);
  const ids = metadata.devices.map(device => device.id);
  if (ids.length) await store.run(`DELETE FROM workspace_devices WHERE account_id=? AND device_id NOT IN (${ids.map(() => "?").join(",")})`, accountId, ...ids);
  else await store.run("DELETE FROM workspace_devices WHERE account_id=?", accountId);
  metadata.deviceOrder = metadata.devices.map(device => device.id);
  metadata.devices = [];
  metadata.storageVersion = 1;
  const value = JSON.stringify(metadata);
  await store.run("UPDATE accounts SET workspace=? WHERE id=? AND workspace<>?", value, accountId, value);
}

export async function readWorkspace(store: Store, accountId: string, value: string, dashboard = false, preserveReferences = false): Promise<string> {
  const workspace = JSON.parse(value) as Workspace & { storageVersion?: number; deviceOrder?: string[] };
  if (workspace.storageVersion === 1) {
    const devices = await store.all<{payload:string}>("SELECT payload FROM workspace_devices WHERE account_id=? ORDER BY device_id", accountId);
    const byId = new Map(devices.map(row => { const device = JSON.parse(row.payload) as Device; return [device.id, device] as const; }));
    workspace.devices = (workspace.deviceOrder ?? [...byId.keys()]).flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  }
  const needed = new Set<string>();
  for (const item of [...workspace.skills, ...(workspace.instructions ?? []), ...(workspace.retiredSkills ?? []), ...(workspace.retiredInstructions ?? [])]) {
    const owners: StoredFiles[] = dashboard ? [] : [item, ...item.versions];
    // Global instructions are small and the dashboard editor shows the published text.
    if (dashboard && (workspace.instructions ?? []).includes(item as any)) owners.push(item);
    if (!dashboard && "proposal" in item && item.proposal) owners.push(item.proposal);
    for (const owner of owners) for (const field of ["filesBundle", "draftBundle"] as const)
      if (owner[field]) needed.add(owner[field]!);
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

export async function migrateWorkspaces(store: Store) {
  // Idempotent and transactional; the old row remains intact if migration fails.
  await store.transaction(async transaction => {
    const accounts = await transaction.all<{id:string;workspace:string}>(`SELECT id,workspace FROM accounts${transaction.dialect === "postgres" ? " FOR UPDATE" : ""}`);
    for (const account of accounts) {
      const value = JSON.parse(account.workspace);
      if (value.storageVersion === 1 || !Array.isArray(value.skills) || !Array.isArray(value.devices)) continue;
      await writeWorkspace(transaction, account.id, value);
    }
  });
}

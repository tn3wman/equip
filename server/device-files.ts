import { createHash } from "node:crypto";
import type { Device, SkillFile } from "../shared/types.ts";
import type { Store } from "./storage.ts";

type Snapshot = { localFiles?: SkillFile[]; localFilesBundle?: string };
type DeviceFiles = Pick<Partial<Device>, "receipts" | "instructionLocations">;
const snapshots = (device: DeviceFiles): Snapshot[] => [...(device.receipts ?? []), ...(device.instructionLocations ?? [])];

export function discardDeviceFileReferences(devices: DeviceFiles[]) {
  for (const device of devices) for (const owner of snapshots(device)) delete owner.localFilesBundle;
}

/** Internal references are produced only from actual snapshots, never client IDs. */
export function packDeviceFiles(device: DeviceFiles, bundles: Map<string, string>) {
  for (const owner of snapshots(device)) {
    delete owner.localFilesBundle;
    if (owner.localFiles === undefined) continue;
    const value = JSON.stringify(owner.localFiles);
    const hash = createHash("sha256").update(value).digest("hex");
    bundles.set(hash, value);
    owner.localFilesBundle = hash;
    delete owner.localFiles;
  }
}

export function deviceFileReferences(device: DeviceFiles): string[] {
  return snapshots(device).flatMap(owner => owner.localFilesBundle ? [owner.localFilesBundle] : []);
}

export async function saveFileBundles(store: Store, accountId: string, bundles: Map<string, string>) {
  const entries = [...bundles];
  for (let offset = 0; offset < entries.length; offset += 200) {
    const batch = entries.slice(offset, offset + 200);
    await store.run(`INSERT INTO skill_bundles(account_id,hash,files) VALUES ${batch.map(() => "(?,?,?)").join(",")} ON CONFLICT DO NOTHING`, ...batch.flatMap(([hash,files]) => [accountId,hash,files]));
  }
}

/** Public reads restore snapshots exactly, including absent versus empty files. */
export async function hydrateDeviceFiles(store: Store, accountId: string, devices: DeviceFiles[]) {
  const hashes = [...new Set(devices.flatMap(deviceFileReferences))];
  const files = new Map<string, SkillFile[]>();
  for (let offset = 0; offset < hashes.length; offset += 200) {
    const batch = hashes.slice(offset, offset + 200);
    const rows = await store.all<{hash:string;files:string}>(`SELECT hash,files FROM skill_bundles WHERE account_id=? AND hash IN (${batch.map(() => "?").join(",")})`, accountId, ...batch);
    for (const row of rows) files.set(row.hash, JSON.parse(row.files));
  }
  for (const device of devices) for (const owner of snapshots(device)) {
    const hash = owner.localFilesBundle;
    if (!hash) continue;
    if (!files.has(hash)) throw new Error("A saved device file bundle is unavailable.");
    owner.localFiles = structuredClone(files.get(hash)!);
    delete owner.localFilesBundle;
  }
}

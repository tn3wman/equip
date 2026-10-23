import type { Store } from "./storage.ts";

/** Merge telemetry inside the database. No device files leave the database. */
export async function updateHeartbeat(store: Store, accountId: string, deviceId: string, patch: Record<string, unknown>, seen: string) {
  const value = JSON.stringify(patch);
  if (store.dialect === "postgres") {
    // Materialize both large JSON values: PostgreSQL otherwise repeats parsing
    // and recursive null stripping for every reference in the UPDATE.
    return store.run(`WITH incoming AS (SELECT ?::jsonb AS patch, ?::text AS seen),
      previous AS MATERIALIZED (
        SELECT account_id,device_id,payload::jsonb AS data FROM workspace_devices
        WHERE account_id=? AND device_id=? AND disconnected=0 FOR UPDATE
      ), merged AS MATERIALIZED (
        SELECT previous.account_id,previous.device_id,previous.data,
          jsonb_strip_nulls(previous.data || incoming.patch ||
            CASE WHEN jsonb_exists(incoming.patch,'localSync') THEN jsonb_build_object('localSync',
              jsonb_build_object('enabled',false) || COALESCE(previous.data->'localSync','{}'::jsonb) ||
              (incoming.patch->'localSync')) ELSE '{}'::jsonb END) AS next
        FROM previous CROSS JOIN incoming
      ) UPDATE workspace_devices SET
      payload=(merged.next || jsonb_build_object('lastSeen',incoming.seen,'online',true))::text,
      last_seen=incoming.seen,
      version=version + CASE WHEN merged.next IS DISTINCT FROM jsonb_strip_nulls(merged.data) THEN 1 ELSE 0 END,
      desired_version=desired_version + CASE WHEN
        (merged.next->'instructionLocations') IS DISTINCT FROM (merged.data->'instructionLocations') OR
        (merged.next->'instructionUnavailable') IS DISTINCT FROM (merged.data->'instructionUnavailable') THEN 1 ELSE 0 END
      FROM merged CROSS JOIN incoming
      WHERE workspace_devices.account_id=merged.account_id AND workspace_devices.device_id=merged.device_id
        AND workspace_devices.disconnected=0`, value, seen, accountId, deviceId);
  }
  const next = `json_patch(CASE WHEN json_type((SELECT patch FROM incoming),'$.localSync') IS NOT NULL AND json_type(payload,'$.localSync') IS NULL
    THEN json_set(payload,'$.localSync',json('{"enabled":false}')) ELSE payload END,(SELECT patch FROM incoming))`;
  return store.run(`WITH incoming(patch,seen) AS (VALUES(?,?)) UPDATE workspace_devices SET
    payload=json_set(${next},'$.lastSeen',(SELECT seen FROM incoming),'$.online',json('true')),
    last_seen=(SELECT seen FROM incoming),
    version=version + CASE WHEN ${next}<>payload THEN 1 ELSE 0 END,
    desired_version=desired_version + CASE WHEN
      json_extract(${next},'$.instructionLocations') IS NOT json_extract(payload,'$.instructionLocations') OR
      json_extract(${next},'$.instructionUnavailable') IS NOT json_extract(payload,'$.instructionUnavailable') THEN 1 ELSE 0 END
    WHERE account_id=? AND device_id=? AND disconnected=0`, value, seen, accountId, deviceId);
}

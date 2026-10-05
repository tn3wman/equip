import type { Workspace } from "./types.ts";

export function pendingChanges(workspace: Workspace) {
  const reviewed = new Set(workspace.reviewedChanges ?? []);
  return {
    updates: workspace.skills.filter(skill => skill.selected && skill.kind === "third-party" && skill.upstreamRevision && skill.upstreamRevision !== skill.revision),
    local: workspace.devices.filter(device => !device.disconnectedAt && !device.disconnect).flatMap(device => device.receipts
      .filter(receipt => receipt.status === "conflicted" && !device.excludedAgents?.some(excluded => excluded.agent === receipt.agent && excluded.profile === receipt.profile && excluded.project === receipt.project))
      .map(receipt => ({device, receipt}))),
    recovered: [...workspace.skills, ...(workspace.instructions ?? []), ...(workspace.retiredSkills ?? []), ...(workspace.retiredInstructions ?? [])].flatMap(item => {
      const versions = item.versions.filter(version => version.message.startsWith("Recovered from ") && !reviewed.has(`recovery:${item.id}:${version.id}`));
      return versions.length ? [{item, versions}] : [];
    }),
  };
}

export function pendingChangeCount(workspace: Workspace) {
  const changes = pendingChanges(workspace);
  const local = new Set(changes.local.map(({receipt}) => `${receipt.kind ?? "skill"}:${receipt.skillId}`));
  return changes.updates.length + local.size + changes.recovered.length;
}

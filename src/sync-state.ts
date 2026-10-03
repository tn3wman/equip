import type { Device, Skill, SyncStatus } from "../shared/types";
export function deployment(
  skill: Skill,
  devices: Device[],
): { status: SyncStatus; complete: number; total: number } {
  const destinations = devices
    .filter((d) => !d.disconnect && !d.disconnectedAt)
    .map((device) => ({
      device,
      agents: device.agents.filter(
        (agent) =>
          !skill.targets.some(
            (t) =>
              t.deviceId === device.id &&
              t.agent === agent.id &&
              (!t.profile || t.profile === agent.profile) &&
              (!t.project || t.project === agent.project) &&
              !t.enabled,
          ),
      ),
    }))
    .filter((d) => d.agents.length);
  let complete = 0;
  let issue: SyncStatus | undefined;
  for (const { device, agents } of destinations) {
    let applied = true;
    for (const agent of agents) {
      const receipt = device.receipts.find(
        (r) =>
          r.skillId === skill.id &&
          r.agent === agent.id &&
          r.profile === agent.profile &&
          r.project === agent.project,
      );
      if (receipt?.status === "conflicted" || receipt?.status === "failed")
        issue = receipt.status;
      if (
        !receipt ||
        receipt.status !== "synchronized" ||
        receipt.revision !== skill.revision
      )
        applied = false;
    }
    if (applied) complete++;
  }
  return {
    status:
      issue ||
      (destinations.length && complete === destinations.length
        ? "synchronized"
        : "pending"),
    complete,
    total: destinations.length,
  };
}
export function deviceStatus(
  device: Device,
  skills: Skill[],
  generation?: number,
): SyncStatus {
  if (!device.online || device.disconnect) return "offline";
  const issue = device.receipts.find(
    (r) => r.status === "conflicted" || r.status === "failed",
  );
  if (issue) return issue.status;
  if (generation !== undefined && device.appliedGeneration !== generation)
    return "pending";
  const published = skills.filter(
    (s) => s.selected && s.enabled && s.versions.length,
  );
  if (!device.agents.length) return "pending";
  if (
    published.some((s) => {
      const result = deployment(s, [device]);
      return result.total > 0 && result.status !== "synchronized";
    })
  )
    return "pending";
  return device.lastSync ? "synchronized" : "pending";
}

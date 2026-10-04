import type { Device, Instructions, Receipt, Skill, SyncStatus } from "../shared/types";
import { instructionDeployment } from "../shared/instructions";
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
export function conflictDevices(skill: Skill, devices: Device[]): Device[] {
  return [...new Map(conflictInstallations(skill, devices).map(({ device }) => [device.id, device])).values()];
}

export function conflictInstallations(skill: Skill, devices: Device[]): { device: Device; receipt: Receipt }[] {
  if (!skill.selected || !skill.enabled || !skill.versions.length) return [];
  return devices.filter(device => !device.disconnect && !device.disconnectedAt).flatMap(device =>
    device.agents.filter(agent => !skill.targets.some(target =>
      target.deviceId === device.id && target.agent === agent.id &&
      (!target.profile || target.profile === agent.profile) &&
      (!target.project || target.project === agent.project) && !target.enabled)).flatMap(agent =>
      device.receipts.filter(receipt => !receipt.kind && receipt.skillId === skill.id &&
        receipt.agent === agent.id && receipt.profile === agent.profile &&
        receipt.project === agent.project && receipt.status === "conflicted").map(receipt => ({ device, receipt }))));
}

export function deviceStatus(
  device: Device,
  skills: Skill[],
  generation?: number,
  instructions: Instructions[] = [],
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
  const publishedInstructions = instructions.filter(
    (document) => document.selected && document.enabled && document.versions.length,
  );
  if (publishedInstructions.length && device.instructionLocations === undefined)
    return "pending";
  if (
    published.some((s) => {
      const result = deployment(s, [device]);
      return result.total > 0 && result.status !== "synchronized";
    })
  )
    return "pending";
  if (publishedInstructions.some((document) => {
    const result = instructionDeployment(document, [device]);
    return result.total > 0 && result.status !== "synchronized";
  })) return "pending";
  return device.lastSync ? "synchronized" : "pending";
}

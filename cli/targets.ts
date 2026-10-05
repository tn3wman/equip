import { resolve } from "node:path";
import type { AgentTarget } from "./sync.ts";

export interface CompatibleAgent {
  id: string;
  name?: string;
  globalPath: string;
  projectPath: string;
  profile?: string;
  aliases?: Array<{ profile: string; path: string }>;
  detection?: "installation" | "configuration";
  detectionPath?: string;
}

export function retainedConfiguredTargets(
  autoDetect: boolean | undefined,
  targets: AgentTarget[],
) {
  return autoDetect === false
    ? targets
    : targets.filter((target) => target.profile || target.project);
}

export function selectAgentTargets(
  compatible: CompatibleAgent[],
  detected: CompatibleAgent[],
  ids?: string[],
  project?: string,
  profile?: string,
): AgentTarget[] {
  const selected = ids?.length
    ? ids.map((id) => {
        const agent = compatible.find((item) => item.id === id);
        if (!agent) throw new Error(`Unknown agent: ${id}`);
        return agent;
      })
    : detected;
  return selected.flatMap((agent): AgentTarget[] => {
    if (project)
      return [
        {
          id: agent.id,
          ...(agent.name ? { name: agent.name } : {}),
          path: resolve(project, agent.projectPath),
          profile,
          project,
        },
      ];
    if (!agent.globalPath) {
      if (ids?.length)
        throw new Error(
          `${agent.id} supports project skills only; provide --project`,
        );
      return [];
    }
    return [
      {
        id: agent.id,
        ...(agent.name ? { name: agent.name } : {}),
        path: resolve(agent.globalPath),
        profile: profile ?? agent.profile,
        ...(agent.aliases ? { aliases: agent.aliases } : {}),
        ...(agent.detection ? { detection: agent.detection } : {}),
        ...(agent.detectionPath ? { detectionPath: agent.detectionPath } : {}),
      },
    ];
  });
}

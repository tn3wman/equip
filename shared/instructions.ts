import type { Device, InstructionLocation, Instructions, Skill } from './types.ts';

export const instructionKey = (id: string, location: Pick<InstructionLocation, 'agent' | 'profile' | 'project'>) =>
  [id, location.agent, location.profile ?? '', location.project ?? ''].join(':');

export function instructionEnabled(document: Instructions, location: InstructionLocation, deviceId?: string) {
  if (!document.selected || !document.enabled ||
      (document.scope === 'project') !== Boolean(location.project)) return false;
  const matches = document.targets.filter(t => (!deviceId || t.deviceId === deviceId) &&
    t.agent === location.agent && (!t.profile || t.profile === location.profile) &&
    (!t.project || t.project === location.project));
  return matches.length ? matches.at(-1)!.enabled : true;
}

// Instruction documents use the existing file comparison and version components.
// They remain separate library entries and never pass through Vercel's skill parser.
export function instructionsAsSkill(document: Instructions): Skill {
  return { ...document, name: document.filename, description: `${document.scope} instructions`,
    author: 'Equip', source: 'custom', kind: 'custom', category: 'Instructions', icon: 'document',
    color: 'green', autoUpdate: false, requirements: [] };
}

export function instructionDeployment(document: Instructions, devices: Device[]) {
  const locations = devices.filter(d => !d.disconnect && !d.disconnectedAt).flatMap(device =>
    (device.instructionLocations ?? []).filter(l => instructionEnabled(document, l, device.id))
      .map(location => ({ device, location })));
  let complete = 0;
  let status: 'synchronized' | 'pending' | 'offline' | 'conflicted' | 'failed' = 'pending';
  for (const {device, location} of locations) {
    const r = device.receipts.find(r => r.kind === 'instructions' && r.skillId === document.id &&
      r.agent === location.agent && r.profile === location.profile && r.project === location.project);
    if (r?.status === 'conflicted' || r?.status === 'failed') status = r.status;
    if (r?.status === 'synchronized' && r.revision === document.revision) complete++;
    else if (!device.online && status === 'pending') status = 'offline';
  }
  if (locations.length && complete === locations.length) status = 'synchronized';
  return {status, complete, total:locations.length};
}

import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { localSkill } from '../local.ts';
import { skillRevision } from '../../shared/library.ts';
import type { Configuration } from './types.ts';
import { configuration } from './validation.ts';

export async function snapshot(input: { provider:string;model:string;harness:string;settings:Record<string,string|number|boolean>;instructions:string[];skills:string[] }): Promise<Configuration> {
  const instructions = [];
  for (const path of input.instructions) {
    const resolved=await realpath(path); const content=await readFile(resolved);
    instructions.push({ path:resolved,sha256:createHash('sha256').update(content).digest('hex') });
  }
  const skills = [];
  for (const path of input.skills) {
    const resolved=await realpath(path); const skill=await localSkill(resolved);
    skills.push({ name:skill.name || basename(resolved),path:resolved,revision:skillRevision(skill.files) });
  }
  return configuration({ provider:input.provider,model:input.model,harness:input.harness,settings:input.settings,instructions,skills,environment:{node:process.versions.node,platform:process.platform,arch:process.arch},basis:'declared' });
}

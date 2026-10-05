import type { SkillFile } from '../shared/types.ts';

/** Resolves only after the server has durably saved the local version. */
export type RecoveryArchive = (payload: {
  skillId: string;
  kind?: 'instructions';
  files: SkillFile[];
  path?: string;
}) => Promise<unknown>;

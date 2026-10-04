export const RELEASE_MANIFEST_SCHEMA = 1 as const;
export const CLI_RELEASE_VERSION = "1.1.1";
export const CLI_NODE_REQUIREMENT = ">=22.20.0";

export type ReleaseManifestPayload = {
  schema: typeof RELEASE_MANIFEST_SCHEMA;
  version: string;
  node: string;
  skillsVersion: string;
  skillsIntegrity: string;
  sha256: string;
  url: string;
  origin: string;
};

export type SignedReleaseManifest = ReleaseManifestPayload & {
  signature: string;
};

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function releasePayload(manifest: ReleaseManifestPayload): string {
  return JSON.stringify({
    schema: manifest.schema,
    version: manifest.version,
    node: manifest.node,
    skillsVersion: manifest.skillsVersion,
    skillsIntegrity: manifest.skillsIntegrity,
    sha256: manifest.sha256,
    url: manifest.url,
    origin: manifest.origin,
  });
}

export function isReleaseVersion(value: string): boolean {
  return versionPattern.test(value);
}

export function compareReleaseVersions(left: string, right: string): number {
  if (!isReleaseVersion(left) || !isReleaseVersion(right))
    throw new Error("Invalid release version.");
  const parts = (value: string) => {
    const [core, prerelease] = value.split("-", 2);
    return { core: core.split(".").map(Number), prerelease };
  };
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const aIdentifiers = a.prerelease.split(".");
  const bIdentifiers = b.prerelease.split(".");
  for (let index = 0; index < Math.max(aIdentifiers.length, bIdentifiers.length); index++) {
    const left = aIdentifiers[index];
    const right = bIdentifiers[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return Number(left) - Number(right);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

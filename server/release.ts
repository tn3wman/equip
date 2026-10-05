import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  CLI_NODE_REQUIREMENT,
  CLI_RELEASE_VERSION,
  RELEASE_MANIFEST_SCHEMA,
  releasePayload,
  type SignedReleaseManifest,
} from "../shared/release.ts";

const integrityCache = new Map<string, string>();

export async function npmPackageIntegrity(
  packageName: string,
  version: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const key = `${packageName}@${version}`;
  if (fetcher === fetch && integrityCache.has(key)) return integrityCache.get(key)!;
  const response = await fetcher(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) throw new Error(`npm registry returned ${response.status}.`);
  const metadata = (await response.json()) as { dist?: { integrity?: unknown } };
  const integrity = metadata.dist?.integrity;
  if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity))
    throw new Error("The skills package has no valid SHA-512 integrity value.");
  if (fetcher === fetch) integrityCache.set(key, integrity);
  return integrity;
}

export async function createReleaseManifest(input: {
  artifact: string;
  origin: string;
  skillsVersion: string;
  skillsIntegrity: string;
  privateKey?: string;
}): Promise<SignedReleaseManifest> {
  const origin = new URL(input.origin).origin;
  const payload = {
    schema: RELEASE_MANIFEST_SCHEMA,
    version: CLI_RELEASE_VERSION,
    node: CLI_NODE_REQUIREMENT,
    skillsVersion: input.skillsVersion,
    skillsIntegrity: input.skillsIntegrity,
    sha256: createHash("sha256").update(await readFile(input.artifact)).digest("hex"),
    url: `${origin}/cli/equip.cjs`,
    origin,
  } as const;
  const privateKey = input.privateKey ?? process.env.EQUIP_RELEASE_PRIVATE_KEY;
  if (!privateKey) {
    if (process.env.NODE_ENV === "production")
      throw new Error("EQUIP_RELEASE_PRIVATE_KEY is required in production.");
    return { ...payload, signature: "development-unsigned" };
  }
  const signature = sign(null, Buffer.from(releasePayload(payload)), createPrivateKey(privateKey));
  return { ...payload, signature: signature.toString("base64") };
}

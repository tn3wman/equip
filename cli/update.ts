import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { execFile } from "node:child_process";
import { platform as hostPlatform } from "node:os";
import { rename, rm, stat, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";
import {
  RELEASE_MANIFEST_SCHEMA,
  compareReleaseVersions,
  isReleaseVersion,
  releasePayload,
  type SignedReleaseManifest,
} from "../shared/release.ts";

const exec = promisify(execFile);

export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA3DDYsvr1wWjlesnP9hKvaaLz1ssv13GOeCtxkYjyqik=
-----END PUBLIC KEY-----`;

export function verifyReleaseManifest(
  input: unknown,
  expectedOrigin: string,
  publicKey = RELEASE_PUBLIC_KEY,
): SignedReleaseManifest {
  if (!input || typeof input !== "object") throw new Error("Invalid release manifest.");
  const manifest = input as Record<string, unknown>;
  const exactKeys = ["node", "origin", "schema", "sha256", "signature", "skillsIntegrity", "skillsVersion", "url", "version"];
  if (Object.keys(manifest).sort().join("\0") !== exactKeys.sort().join("\0"))
    throw new Error("Invalid release manifest fields.");
  if (
    manifest.schema !== RELEASE_MANIFEST_SCHEMA ||
    typeof manifest.version !== "string" || !isReleaseVersion(manifest.version) ||
    manifest.node !== ">=22.20.0" ||
    typeof manifest.skillsVersion !== "string" || !isReleaseVersion(manifest.skillsVersion) ||
    typeof manifest.skillsIntegrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(manifest.skillsIntegrity) ||
    typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    typeof manifest.url !== "string" || typeof manifest.origin !== "string" ||
    typeof manifest.signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(manifest.signature)
  ) throw new Error("Invalid release manifest.");
  const expected = new URL(expectedOrigin);
  const origin = new URL(manifest.origin);
  const artifact = new URL(manifest.url);
  if (expected.protocol !== "https:" || origin.protocol !== "https:")
    throw new Error("Automatic updates require HTTPS.");
  if (origin.origin !== expected.origin || artifact.origin !== expected.origin || artifact.pathname !== "/cli/equip.cjs" || artifact.search || artifact.hash)
    throw new Error("Release manifest origin mismatch.");
  if (!publicKey) throw new Error("This CLI has no pinned release key.");
  const signed = manifest as SignedReleaseManifest;
  const valid = verify(
    null,
    Buffer.from(releasePayload(signed)),
    createPublicKey(publicKey),
    Buffer.from(signed.signature, "base64"),
  );
  if (!valid) throw new Error("Release manifest signature is invalid.");
  return signed;
}

export function verifyReleaseUpgrade(
  manifest: SignedReleaseManifest,
  currentCliVersion: string,
  currentSkillsVersion: string,
  artifactChanged = false,
) {
  const cliComparison = compareReleaseVersions(manifest.version, currentCliVersion);
  if (cliComparison < 0)
    throw new Error("Release manifest would downgrade Equip.");
  if (artifactChanged && cliComparison === 0)
    throw new Error("Release manifest reuses the current Equip version for a different artifact.");
  if (compareReleaseVersions(manifest.skillsVersion, currentSkillsVersion) < 0)
    throw new Error("Release manifest would downgrade the skills runtime.");
}

export function verifyArtifact(data: Buffer, sha256: string) {
  if (createHash("sha256").update(data).digest("hex") !== sha256)
    throw new Error("CLI update hash mismatch.");
}

export function verifyPackageIntegrity(data: Buffer, integrity: string) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!match || createHash("sha512").update(data).digest("base64") !== match[1])
    throw new Error("Skills package integrity does not match the signed release.");
}

export async function runNpmCommand(
  executable: string,
  args: string[],
  options: { os?: NodeJS.Platform; node?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
) {
  const os = options.os ?? hostPlatform();
  const timeout = options.timeout ?? 180_000;
  if ([".js", ".cjs", ".mjs"].includes(extname(executable).toLowerCase()))
    return exec(options.node ?? process.execPath, [executable, ...args], { timeout, env: options.env });
  if (os === "win32" && [".cmd", ".bat"].includes(extname(executable).toLowerCase())) {
    const quote = (value: string) => `"${value.replace(/%/g, "%%").replace(/"/g, '""')}"`;
    const command = `"${[quote(executable), ...args.map(quote)].join(" ")}"`;
    return exec(options.env?.ComSpec || process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
      timeout,
      env: options.env,
      windowsVerbatimArguments: true,
    });
  }
  return exec(executable, args, { timeout, env: options.env });
}

export async function promoteDirectoryWithRollback(
  live: string,
  staged: string,
  afterPromotion: () => Promise<void>,
  move: typeof rename = rename,
) {
  const backup = `${live}.${randomUUID()}.previous`;
  const hadLive = await stat(live).then(() => true).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
  if (hadLive) await move(live, backup);
  try {
    await move(staged, live);
    await afterPromotion();
  } catch (error) {
    let rollbackError: unknown;
    try {
      await rm(live, { recursive: true, force: true });
      if (hadLive) await move(backup, live);
    } catch (cause) {
      rollbackError = cause;
    }
    if (rollbackError)
      throw new AggregateError(
        [error, rollbackError],
        "Update failed and the previous Skills runtime could not be restored.",
      );
    throw error;
  }
  if (hadLive) await rm(backup, { recursive: true, force: true }).catch(() => {});
}

export async function replaceExecutable(
  executable: string,
  data: Buffer,
  os: NodeJS.Platform = hostPlatform(),
  move: typeof rename = rename,
) {
  const stage = `${executable}.${randomUUID()}.update`;
  await writeFile(stage, data, { mode: 0o755 });
  if (os !== "win32") {
    try {
      await move(stage, executable);
    } catch (error) {
      await rm(stage, { force: true }).catch(() => {});
      throw error;
    }
    return;
  }
  const old = `${executable}.previous`;
  try {
    await rm(old, { force: true });
    await move(executable, old);
  } catch (error) {
    await rm(stage, { force: true }).catch(() => {});
    throw error;
  }
  try {
    await move(stage, executable);
  } catch (error) {
    let rollbackError: unknown;
    try {
      await rm(executable, { force: true });
      await move(old, executable);
    } catch (cause) {
      rollbackError = cause;
    }
    await rm(stage, { force: true }).catch(() => {});
    if (rollbackError)
      throw new AggregateError(
        [error, rollbackError],
        "CLI update failed and the previous executable could not be restored.",
      );
    throw error;
  }
  await rm(old, { force: true }).catch(() => {});
}

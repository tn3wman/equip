import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RELEASE_PUBLIC_KEYS, promoteDirectoryWithRollback, verifyArtifact, verifyPackageIntegrity, verifyReleaseManifest, verifyReleaseUpgrade } from "../cli/update.ts";
import { createReleaseManifest } from "../server/release.ts";
import { releasePayload, type SignedReleaseManifest } from "../shared/release.ts";

const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "equip-release-"));
  const artifact = join(root, "equip.cjs");
  await writeFile(artifact, "signed release");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest = await createReleaseManifest({
    artifact,
    origin: "https://equip.example",
    skillsVersion: "1.7.0",
    skillsIntegrity: integrity,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
  return {
    root,
    manifest,
    privateKey,
    publicKeys: [publicKey.export({ type: "spki", format: "pem" }).toString()],
  };
}

test("release manifests verify the exact canonical payload", async () => {
  const item = await fixture();
  try {
    assert.deepEqual(
      verifyReleaseManifest(item.manifest, "https://equip.example/path", item.publicKeys),
      item.manifest,
    );
    for (const field of ["version", "skillsVersion", "skillsIntegrity", "sha256", "url", "origin"] as const) {
      const changed = { ...item.manifest, [field]: field === "sha256" ? "0".repeat(64) : `${item.manifest[field]}x` };
      assert.throws(() => verifyReleaseManifest(changed, "https://equip.example", item.publicKeys));
    }
    assert.throws(() => verifyReleaseManifest({ ...item.manifest, extra: true }, "https://equip.example", item.publicKeys), /fields/);
    assert.throws(() => verifyReleaseManifest({ ...item.manifest, signature: "development-unsigned" }, "https://equip.example", item.publicKeys));
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("release verification rejects another origin, HTTP, downgrade, and artifact tampering", async () => {
  const item = await fixture();
  try {
    assert.throws(() => verifyReleaseManifest(item.manifest, "https://mirror.example", item.publicKeys), /origin/);
    assert.throws(() => verifyReleaseManifest(item.manifest, "http://equip.example", item.publicKeys), /HTTPS/);
    assert.throws(() => verifyReleaseUpgrade({ ...item.manifest, version: "0.9.0" }, "1.0.0", "1.7.0"), /downgrade Equip/);
    assert.throws(() => verifyReleaseUpgrade({ ...item.manifest, skillsVersion: "1.6.9" }, "1.0.0", "1.7.0"), /downgrade the skills/);
    assert.throws(() => verifyArtifact(Buffer.from("tampered"), item.manifest.sha256), /hash mismatch/);
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("a signed release cannot replace a different artifact without increasing its version", async () => {
  const item = await fixture();
  try {
    const verified = verifyReleaseManifest(item.manifest, "https://equip.example", item.publicKeys);
    assert.throws(
      () => verifyReleaseUpgrade(verified, verified.version, verified.skillsVersion, true),
      /reuses the current Equip version/,
    );
    assert.doesNotThrow(() => verifyReleaseUpgrade(verified, verified.version, "1.6.0", false));
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

// The release key pinned by CLIs <= 1.1.8. Its private key leaked, so no later CLI may trust it.
const LEAKED_RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA3DDYsvr1wWjlesnP9hKvaaLz1ssv13GOeCtxkYjyqik=
-----END PUBLIC KEY-----`;

const rawKey = (pem: string) =>
  createPublicKey(pem).export({ type: "spki", format: "der" }).toString("base64");

test("the CLI trusts exactly the primary and offline backup keys, never the leaked key", () => {
  assert.deepEqual(RELEASE_PUBLIC_KEYS.map(rawKey), [
    "MCowBQYDK2VwAyEAfLCDpuNEx4LyU4WgqY7XDaMiScpZz6EoGjbSTsqzSf4=",
    "MCowBQYDK2VwAyEAbGKWQ2wk5BuCTGG7nGMlQnUDF/hfADjeMXCnJh6EssY=",
  ]);
  for (const key of RELEASE_PUBLIC_KEYS) assert.equal(createPublicKey(key).asymmetricKeyType, "ed25519");
  assert.ok(!RELEASE_PUBLIC_KEYS.map(rawKey).includes(rawKey(LEAKED_RELEASE_PUBLIC_KEY)));
});

test("a manifest verifies against any trusted key and is rejected by every other key", async () => {
  const primary = await fixture();
  const backup = await fixture();
  const unknown = await fixture();
  try {
    const trusted = [...primary.publicKeys, ...backup.publicKeys];
    assert.deepEqual(verifyReleaseManifest(primary.manifest, "https://equip.example", trusted), primary.manifest);
    assert.deepEqual(verifyReleaseManifest(backup.manifest, "https://equip.example", trusted), backup.manifest);
    assert.throws(() => verifyReleaseManifest(unknown.manifest, "https://equip.example", trusted), /signature is invalid/);
    assert.throws(() => verifyReleaseManifest(primary.manifest, "https://equip.example", []), /no pinned release key/);
    // Shipped CLIs reject manifests signed by any key outside the pinned list,
    // including the leaked key served on the legacy /cli/manifest route.
    assert.throws(() => verifyReleaseManifest(unknown.manifest, "https://equip.example"), /signature is invalid/);
    assert.throws(
      () => verifyReleaseManifest(primary.manifest, "https://equip.example", [LEAKED_RELEASE_PUBLIC_KEY]),
      /signature is invalid/,
    );
  } finally {
    for (const item of [primary, backup, unknown]) await rm(item.root, { recursive: true, force: true });
  }
});

test("a signature made over a noncanonical or partial payload is rejected", async () => {
  const item = await fixture();
  try {
    const altered = { ...item.manifest, signature: sign(null, Buffer.from(JSON.stringify(item.manifest)), item.privateKey).toString("base64") };
    assert.throws(() => verifyReleaseManifest(altered, "https://equip.example", item.publicKeys), /signature/);
    assert.equal(typeof releasePayload(item.manifest as SignedReleaseManifest), "string");
  } finally {
    await rm(item.root, { recursive: true, force: true });
  }
});

test("the signed Skills integrity binds the downloaded package bytes", () => {
  const tarball = Buffer.from("exact package tarball bytes");
  const expected = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  assert.doesNotThrow(() => verifyPackageIntegrity(tarball, expected));
  assert.throws(
    () => verifyPackageIntegrity(Buffer.from("different package bytes"), expected),
    /does not match the signed release/,
  );
});

test("a failed CLI promotion restores the last working Skills runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "equip-runtime-rollback-"));
  const live = join(root, "node_modules");
  const staged = join(root, "stage", "node_modules");
  try {
    await mkdir(join(live, "skills"), { recursive: true });
    await mkdir(join(staged, "skills"), { recursive: true });
    await writeFile(join(live, "skills", "package.json"), JSON.stringify({ version: "1.7.0" }));
    await writeFile(join(staged, "skills", "package.json"), JSON.stringify({ version: "1.8.0" }));
    await assert.rejects(
      promoteDirectoryWithRollback(live, staged, async () => {
        throw new Error("simulated CLI promotion failure");
      }),
      /simulated CLI promotion failure/,
    );
    assert.deepEqual(JSON.parse(await readFile(join(live, "skills", "package.json"), "utf8")), { version: "1.7.0" });
    assert.deepEqual((await readdir(root)).sort(), ["node_modules", "stage"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

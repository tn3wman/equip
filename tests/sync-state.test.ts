import { test } from "node:test";
import assert from "node:assert/strict";
import { deployment, deviceStatus } from "../src/sync-state.ts";
import type { Device, Skill } from "../shared/types.ts";
const skill = {
  id: "skill",
  name: "skill",
  revision: "new",
  selected: true,
  enabled: true,
  versions: [{ revision: "new" }],
  targets: [],
} as unknown as Skill;
const receipt = {
  skillId: "skill",
  agent: "codex",
  revision: "new",
  status: "synchronized",
  timestamp: new Date().toISOString(),
} as const;
const device = {
  id: "device",
  online: true,
  agents: [{ id: "codex", name: "Codex", path: "/agent" }],
  receipts: [receipt],
  lastSync: receipt.timestamp,
  appliedGeneration: 2,
} as Device;
test("a new desired generation stays pending until the device confirms cleanup", () => {
  assert.equal(deviceStatus(device, [skill], 2), "synchronized");
  assert.equal(deviceStatus(device, [], 3), "pending");
  assert.equal(
    deviceStatus({ ...device, receipts: [], appliedGeneration: 3 }, [], 3),
    "synchronized",
  );
});
test("every selected profile needs an exact revision receipt", () => {
  const profiles = {
    ...device,
    agents: [
      ...device.agents,
      { id: "codex", name: "Codex", path: "/work", profile: "work" },
    ],
  };
  assert.equal(deployment(skill, [profiles]).status, "pending");
  const completed = {
    ...profiles,
    receipts: [receipt, { ...receipt, profile: "work" }],
  };
  assert.equal(deployment(skill, [completed]).status, "synchronized");
  assert.equal(
    deployment(skill, [
      {
        ...completed,
        receipts: [receipt, { ...receipt, profile: "work", revision: "old" }],
      },
    ]).status,
    "pending",
  );
});
test("an exception excludes only its selected profile and offline status stays visible", () => {
  const profiles = {
    ...device,
    agents: [
      ...device.agents,
      { id: "codex", name: "Codex", path: "/work", profile: "work" },
    ],
  };
  const configured = {
    ...skill,
    targets: [
      { deviceId: "device", agent: "codex", profile: "work", enabled: false },
    ],
  };
  assert.equal(deployment(configured, [profiles]).status, "synchronized");
  assert.equal(
    deviceStatus({ ...device, online: false }, [skill], 2),
    "offline",
  );
  assert.equal(
    deviceStatus(
      { ...device, receipts: [{ ...receipt, status: "conflicted" }] },
      [skill],
      2,
    ),
    "conflicted",
  );
});

test("excluded destinations stay synchronized after confirmed removal", () => {
  const excluded = {
    ...skill,
    targets: [{ deviceId: "device", agent: "codex", enabled: false }],
  };
  assert.equal(
    deviceStatus({ ...device, receipts: [] }, [excluded], 2),
    "synchronized",
  );
});

test("completed disconnections no longer count as deployment destinations", () => {
  const disconnected = {
    ...device,
    disconnectedAt: new Date().toISOString(),
  };
  assert.deepEqual(deployment(skill, [device, disconnected]), {
    status: "synchronized",
    complete: 1,
    total: 1,
  });
});

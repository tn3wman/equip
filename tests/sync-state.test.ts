import { test } from "node:test";
import assert from "node:assert/strict";
import { conflictDevices, conflictInstallations, deployment, deviceStatus } from "../src/sync-state.ts";
import type { Device, Instructions, Skill } from "../shared/types.ts";
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

test("a computer exclusion removes only the exact agent configuration", () => {
  const profiles = {
    ...device,
    agents: [
      ...device.agents,
      { id: "codex", name: "Codex", path: "/work", profile: "work" },
    ],
    excludedAgents: [{ agent: "codex", profile: "work" }],
  };
  assert.deepEqual(deployment(skill, [profiles]), {
    status: "synchronized",
    complete: 1,
    total: 1,
  });
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

test("conflict origins identify only the affected active computer", () => {
  const conflicted = {
    ...device,
    id: "aitopatom",
    name: "aitopatom",
    receipts: [{ ...receipt, status: "conflicted" as const }],
  };
  const synchronized = {
    ...device,
    id: "mac",
    name: "Mac",
  };

  assert.deepEqual(deployment(skill, [conflicted, synchronized]), {
    status: "conflicted",
    complete: 1,
    total: 2,
  });
  assert.deepEqual(
    conflictDevices(skill, [conflicted, synchronized]).map(({ id }) => id),
    ["aitopatom"],
  );
});

test("conflict origins require an exact enabled destination receipt", () => {
  const profiles = {
    ...device,
    agents: [
      { id: "codex", name: "Codex", path: "/agent" },
      {
        id: "codex",
        name: "Codex",
        path: "/work",
        profile: "work",
        project: "/project",
      },
    ],
    receipts: [
      { ...receipt, skillId: "other", status: "conflicted" as const },
      {
        ...receipt,
        profile: "work",
        project: "/other-project",
        status: "conflicted" as const,
      },
      {
        ...receipt,
        profile: "work",
        project: "/project",
        status: "conflicted" as const,
      },
    ],
  };
  const configured = {
    ...skill,
    targets: [
      {
        deviceId: "device",
        agent: "codex",
        profile: "work",
        project: "/project",
        enabled: false,
      },
    ],
  };

  assert.deepEqual(conflictDevices(configured, [profiles]), []);
  assert.deepEqual(conflictDevices(skill, [profiles]).map(({ id }) => id), [
    "device",
  ]);
});

test("conflict origins ignore disconnecting and disconnected computers", () => {
  const conflicted = {
    ...device,
    receipts: [{ ...receipt, status: "conflicted" as const }],
  };

  assert.deepEqual(
    conflictDevices(skill, [
      { ...conflicted, id: "disconnecting", disconnect: "retain" },
      {
        ...conflicted,
        id: "disconnected",
        disconnectedAt: new Date().toISOString(),
      },
    ]),
    [],
  );
});

test("bulk Equip replacement selects each enabled conflict, including offline computers", () => {
  const offline = {
    ...device,
    online: false,
    agents: [...device.agents, { id: "codex", name: "Codex", path: "/work", profile: "work" }],
    receipts: [
      { ...receipt, status: "conflicted" as const },
      { ...receipt, profile: "work", status: "conflicted" as const },
      { ...receipt, kind: "instructions" as const, status: "conflicted" as const },
      { ...receipt, agent: "unknown", status: "conflicted" as const },
    ],
  };
  assert.deepEqual(conflictInstallations(skill, [offline]).map(({ receipt }) => receipt.profile), [undefined, "work"]);
  assert.equal(conflictDevices(skill, [offline]).length, 1);
  assert.deepEqual(conflictInstallations({ ...skill, targets: [{ deviceId: device.id, agent: "codex", profile: "work", enabled: false }] }, [offline]).map(({ receipt }) => receipt.profile), [undefined]);
  assert.deepEqual(conflictInstallations({ ...skill, enabled: false }, [offline]), []);
});

test("published instructions keep older workers pending until locations are reported", () => {
  const instructions = {
    id: "instructions",
    filename: "AGENTS.md",
    scope: "global",
    selected: true,
    enabled: true,
    revision: "instruction-r1",
    versions: [{ revision: "instruction-r1" }],
    targets: [],
  } as unknown as Instructions;
  assert.equal(deviceStatus(device, [skill], 2, [instructions]), "pending");
  assert.equal(deviceStatus({ ...device, instructionLocations: [] }, [skill], 2, [instructions]), "synchronized");
  const capable = {
    ...device,
    instructionLocations: [{ agent: "codex", filename: "AGENTS.md" as const, path: "/config/AGENTS.md" }],
    receipts: [...device.receipts, { ...receipt, kind: "instructions" as const, skillId: "instructions", revision: "instruction-r1" }],
  };
  assert.equal(deviceStatus(capable, [skill], 2, [instructions]), "synchronized");
});

test("stale and unsupported instruction failures do not mark skill sync failed", () => {
  const staleInstructionFailure = {
    ...device,
    instructionLocations: [],
    instructionUnavailable: [{ agent: "windsurf", reason: "The published instructions exceed its native limit." }],
    receipts: [...device.receipts, {
      ...receipt,
      kind: "instructions" as const,
      skillId: "old-instructions",
      agent: "windsurf",
      status: "failed" as const,
      message: "Native limit",
    }],
  };
  assert.equal(deviceStatus(staleInstructionFailure, [skill], 2, []), "synchronized");
});

test("a current enabled skill failure still marks the device failed", () => {
  const failed = {
    ...device,
    receipts: [{ ...receipt, status: "failed" as const }],
  };
  assert.equal(deviceStatus(failed, [skill], 2), "failed");
});

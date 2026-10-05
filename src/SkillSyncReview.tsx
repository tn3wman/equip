import { useState } from "react";
import { Check, GitBranch, Loader2 } from "lucide-react";
import type { Device, Receipt, Skill, SkillFile, Workspace } from "../shared/types";
import { reviewedFilesRevision } from "../shared/conflicts";
import { api } from "./api";
import { Dialog, Status, revision } from "./components";
import { conflictInstallations, deployment } from "./sync-state";
import SkillConflict from "./SkillConflict";

export default function SkillSyncReview({ skill, workspace, onClose, onChange, notify, onInspect }: {
  skill: Skill;
  workspace: Workspace;
  onClose: () => void;
  onChange: () => Promise<void>;
  notify: (message: string) => void;
  onInspect?: () => void;
}) {
  const [review, setReview] = useState<{ device: Device; receipt: Receipt }>();
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState("");
  const locations = conflictInstallations(skill, workspace.devices);
  const state = deployment(skill, workspace.devices);
  const resolve = async (location: { device: Device; receipt: Receipt }, action: "replace" | "preserve" | "import" | "publish" | "merge", expectedRevision = skill.revision, mergedFiles?: SkillFile[]) => {
    const { device, receipt } = location;
    await api(`/devices/${device.id}/resolve`, "POST", {
      skillId: skill.id, agent: receipt.agent, profile: receipt.profile, project: receipt.project,
      action, expectedRevision, mergedFiles,
      expectedLocalRevision: receipt.localFiles ? await reviewedFilesRevision(receipt.localFiles) : undefined,
    });
  };
  const useEquip = async () => {
    setBusy(true);
    setError("");
    try {
      // Each choice is tied to the exact local snapshot and selected Equip revision.
      const results = await Promise.allSettled(locations.map(location => resolve(location, "replace")));
      const failures = results.flatMap((result, index) => result.status === "rejected"
        ? [`${locations[index].device.name}: ${result.reason instanceof Error ? result.reason.message : "Could not queue this installation."}`] : []);
      setQueued(results.some(result => result.status === "fulfilled"));
      await onChange();
      setError(failures.join(" "));
      if (!failures.length) notify("Equip version selected. Computers will save differing versions in history and confirm installation.");
    } catch (requestError) { setError((requestError as Error).message); }
    finally { setBusy(false); }
  };
  if (review) return <SkillConflict
    skill={skill}
    device={workspace.devices.find(device => device.id === review.device.id) || review.device}
    receipt={review.receipt}
    onClose={() => setReview(undefined)}
    onResolve={async (action, expectedRevision, mergedFiles) => {
      await resolve(review, action, expectedRevision, mergedFiles);
      await onChange();
      notify(action === "publish" ? "Local version published. Computers will confirm installation." : "Choice queued. Waiting for this computer to confirm it.");
    }}
  />;
  return <Dialog title={`Resolve ${skill.title}`} onClose={onClose}>
    <div className="dialog-body skill-sync-review">
      <div className="sync-selected"><GitBranch size={20} /><div><strong>Equip controls the installed version</strong><p>Selected revision <code>{revision(skill.revision)}</code>{skill.kind === "third-party" ? ` from ${skill.source}` : ""}.</p></div></div>
      {onInspect && <button className="text-link" onClick={onInspect}>View skill details and upstream updates</button>}
      <p>A local copy differs from Equip. This can happen when connecting a computer with an existing installation, or after editing files locally.</p>
      <p>Use Equip's version to make every selected computer and agent consistent. Equip saves differing local versions in history before linking agents to its canonical copy.</p>
      {locations.map(({ device, receipt }, index) => <div className="sync-conflict-location" key={`${device.id}:${index}`}>
        <div><strong>{device.name}</strong><small>{[device.agents.find(agent => agent.id === receipt.agent && agent.profile === receipt.profile && agent.project === receipt.project)?.name || receipt.agent, receipt.profile, receipt.project].filter(Boolean).join(" · ")}</small><code title={receipt.path}>{receipt.path}</code></div>
        <button className="text-link" onClick={() => setReview({ device, receipt })}>Review differences</button>
      </div>)}
      {(queued || !locations.length) && <div className="notice" role="status"><Check size={17} /><span>{state.status === "synchronized" ? "Every selected computer confirmed Equip's revision." : "Waiting for computer receipts. Offline computers apply your choice when they reconnect."}</span></div>}
      <Status status={state.status} />
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="button" onClick={onClose}>Close</button>
        {!!locations.length && <button className="button primary" disabled={busy || (queued && !error)} onClick={() => void useEquip()}>{busy && <Loader2 size={16} className="spin" />}{queued && !error ? "Waiting for computers" : "Use Equip version on all computers"}</button>}
      </div>
    </div>
  </Dialog>;
}

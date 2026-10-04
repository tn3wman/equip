import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, FileCode2, FilePlus2, FileX2, ShieldCheck } from "lucide-react";
import type { Device, Receipt, Skill } from "../shared/types";
import { compareSkillFiles, diffLines } from "../shared/conflicts";
import { Dialog, revision } from "./components";
import { api } from "./api";

type Resolution = "replace" | "preserve" | "import" | "publish";

export default function SkillConflict({
  skill,
  device,
  receipt,
  onClose,
  onResolve,
}: {
  skill?: Skill;
  device: Device;
  receipt: Receipt;
  onClose: () => void;
  onResolve: (action: Resolution, expectedRevision: string) => Promise<void>;
}) {
  const [equipSkill, setEquipSkill] = useState(skill);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    if (!skill || skill.files.length) return;
    let cancelled = false;
    void api<Skill>(`/skills/${skill.id}`)
      .then((complete) => { if (!cancelled) setEquipSkill(complete); })
      .catch((error) => { if (!cancelled) setLoadError((error as Error).message); });
    return () => { cancelled = true; };
  }, [skill?.id]);
  const comparisons = useMemo(
    () => compareSkillFiles(receipt.localFiles || [], equipSkill?.files || []),
    [receipt.localFiles, equipSkill?.files],
  );
  const [selectedPath, setSelectedPath] = useState(comparisons[0]?.path);
  const [queued, setQueued] = useState<Resolution>();
  const [submitting, setSubmitting] = useState<Resolution>();
  const [resolveError, setResolveError] = useState("");
  const selected = comparisons.find((file) => file.path === selectedPath) || comparisons[0];
  const allLines = selected && !selected.binary && selected.contentChanged
    ? diffLines(selected.localText || "", selected.equipText || "")
    : [];
  const lines = allLines.slice(0, 1_500);
  const agent = device.agents.find((candidate) => candidate.id === receipt.agent);
  const scope = [agent?.name || receipt.agent, receipt.profile, receipt.project].filter(Boolean).join(" · ");
  const permissionChanges = comparisons.filter((file) => file.modeChanged).length;
  const contentChanges = comparisons.filter((file) => file.contentChanged).length;
  const comparisonReady = Boolean(equipSkill?.files.length) && !loadError;
  const queuedCopy = queued === "replace"
    ? "Equip will back up the local folder, then install its version."
    : queued === "publish"
      ? "Local version published to Equip. Selected destinations are applying that revision; completion requires receipts."
      : queued === "preserve"
        ? "This computer will keep its local version and stop updates for this installation."
        : "Equip will save the local files as a separate custom draft.";
  const latestReceipt = device.receipts.find(item => item.skillId === receipt.skillId && item.agent === receipt.agent && item.profile === receipt.profile && item.project === receipt.project);
  const excluded = skill?.targets.some(target => target.deviceId === device.id && target.agent === receipt.agent && target.profile === receipt.profile && target.project === receipt.project && !target.enabled);
  const completed = Boolean(queued && (
    queued === "preserve" || queued === "import"
      ? excluded && !latestReceipt
      : latestReceipt?.status === "synchronized" && latestReceipt.revision === skill?.revision
  ));

  const resolve = async (action: Resolution) => {
    if (!comparisonReady || !equipSkill) return;
    setSubmitting(action);
    setResolveError("");
    try {
      await onResolve(action, equipSkill.revision);
      setQueued(action);
    } catch (error) {
      setResolveError((error as Error).message);
    } finally {
      setSubmitting(undefined);
    }
  };

  return (
    <Dialog title="Review skill conflict" onClose={onClose} wide>
      <div className="conflict-dialog-body">
        <header className="conflict-summary">
          <div>
            <span className="conflict-kicker">{equipSkill?.title || receipt.skillId}</span>
            <h3>{device.name}</h3>
            <p>{scope || "Unknown agent location"}</p>
            {agent?.aliases && agent.aliases.length > 1 && (
              <p>{agent.aliases.map((alias) => alias.profile).join(", ")} share this physical skill folder.</p>
            )}
          </div>
          <dl>
            <div><dt>Local path</dt><dd><code>{receipt.path || "Path unavailable"}</code></dd></div>
            <div><dt>Last Equip baseline</dt><dd><code>{receipt.revision ? revision(receipt.revision) : "Unknown"}</code></dd></div>
            <div><dt>Equip revision</dt><dd><code>{revision(equipSkill?.revision || "")}</code></dd></div>
            <div><dt>Comparison basis</dt><dd>{receipt.revision ? "Previously compared with the recorded Equip baseline" : "No shared baseline; neither version is assumed newer"}</dd></div>
          </dl>
          <div className="conflict-counts" aria-label="Conflict summary">
            <strong>{comparisons.length}</strong><span>changed {comparisons.length === 1 ? "file" : "files"}</span>
            <strong>{contentChanges}</strong><span>content</span>
            <strong>{permissionChanges}</strong><span>permissions</span>
          </div>
        </header>

        <div className="conflict-workbench">
          <nav className="conflict-files" aria-label="Changed files">
            <div className="conflict-pane-title">Changed files</div>
            {loadError ? <p className="conflict-empty">Could not load the Equip version: {loadError}</p> : !equipSkill?.files.length ? <p className="conflict-empty">Loading the Equip version…</p> : comparisons.length ? comparisons.map((file) => (
              <button
                type="button"
                key={file.path}
                className={selected?.path === file.path ? "active" : ""}
                onClick={() => setSelectedPath(file.path)}
              >
                {file.status === "added" ? <FilePlus2 size={14} /> : file.status === "removed" ? <FileX2 size={14} /> : file.status === "permissions" ? <ShieldCheck size={14} /> : <FileCode2 size={14} />}
                <span><strong>{file.path}</strong><small>{file.status === "added" ? "Only in Equip" : file.status === "removed" ? "Only on this computer" : file.status === "permissions" ? "Permissions differ" : file.modeChanged ? "Content and permissions differ" : "Content differs"}</small></span>
              </button>
            )) : <p className="conflict-empty">The file details are unavailable for this receipt.</p>}
          </nav>

          <section className="conflict-diff" aria-label={selected ? `Differences in ${selected.path}` : "File differences"}>
            <div className="conflict-pane-title">
              <span>{selected?.path || "No file selected"}</span>
              {selected?.binary && <span>Binary file</span>}
            </div>
            {selected?.binary ? (
              <div className="binary-diff"><FileCode2 size={24} /><strong>Binary content differs</strong><p>Equip cannot show a line comparison. Choose a version below to keep its exact bytes.</p></div>
            ) : selected?.contentChanged ? (
              <div className="diff-code" role="table" aria-label="Line comparison">
                {lines.map((line, index) => (
                  <div className={`diff-line ${line.kind}`} role="row" key={`${index}-${line.kind}`}>
                    <span role="cell">{line.localLine ?? ""}</span>
                    <span role="cell">{line.equipLine ?? ""}</span>
                    <code role="cell">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}{line.text}</code>
                  </div>
                ))}
                {allLines.length > lines.length && <div className="diff-truncated">Showing the first 1,500 lines of this comparison.</div>}
              </div>
            ) : selected?.modeChanged ? (
              <div className="permission-diff"><ShieldCheck size={22} /><strong>File permissions differ</strong><p>Local: <code>{selected.local?.mode?.toString(8) || "644"}</code> · Equip: <code>{selected.equip?.mode?.toString(8) || "644"}</code></p></div>
            ) : (
              <div className="binary-diff"><p>Select a changed file to inspect it.</p></div>
            )}
          </section>
        </div>

        <div className="conflict-legend"><span className="remove">Local removal</span><span className="add">Equip addition</span><span>Line numbers: local / Equip</span></div>

        {queued ? (
          <div className="conflict-queued" role="status"><Check size={17} /><div><strong>{completed ? "Computer confirmed your choice" : queued === "publish" ? "Local version published" : "Choice queued for this computer"}</strong><p>{completed ? "This installation has reconciled. Other selected destinations report their progress in Computers." : `${queuedCopy} The conflict stays visible until the computer reports completion.`}</p></div></div>
        ) : (
          <div className="conflict-choices">
            <button type="button" disabled={Boolean(submitting) || !comparisonReady} onClick={() => void resolve("replace")}><strong>Use Equip version</strong><span>Back up the local folder, then replace it with Equip’s revision.</span></button>
            <button type="button" disabled={Boolean(submitting) || !comparisonReady || !receipt.localFiles?.length} onClick={() => void resolve("publish")}><strong>Use local version everywhere</strong><span>Publish this reviewed local folder snapshot to Equip and all selected destinations. Files on this computer are preserved.</span><em>For a third-party skill, this creates a custom copy and turns off automatic upstream updates.</em></button>
            <button type="button" disabled={Boolean(submitting) || !comparisonReady} onClick={() => void resolve("preserve")}><strong>Keep local on this computer</strong><span>Create an exception here and stop updates for this installation.</span></button>
            <button type="button" disabled={Boolean(submitting) || !comparisonReady || !receipt.localFiles?.length} onClick={() => void resolve("import")}><strong>Save local as custom draft</strong><span>Keep the local work in Equip as a separate unpublished draft.</span></button>
          </div>
        )}
        {!receipt.localFiles?.length && <p className="conflict-note"><AlertTriangle size={14} /> Local file contents were not included in this receipt, so Equip cannot create a draft.</p>}
        {resolveError && <p className="conflict-resolution-error" role="alert"><AlertTriangle size={14} /> {resolveError}</p>}
      </div>
    </Dialog>
  );
}

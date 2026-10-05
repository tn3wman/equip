import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, FileCode2, FilePlus2, FileX2, ShieldCheck } from "lucide-react";
import type { Device, Receipt, Skill } from "../shared/types";
import { compareSkillFiles, diffLines } from "../shared/conflicts";
import { hasMergeMarkers, mergeSkillFiles } from "../shared/merge";
import type { SkillFile } from "../shared/types";
import { Dialog, revision } from "./components";
import { api } from "./api";

type Resolution = "replace" | "preserve" | "import" | "publish" | "merge";

export default function SkillConflict({
  skill,
  device,
  receipt,
  onClose,
  onResolve,
  documentKind,
}: {
  skill?: Skill;
  device: Device;
  receipt: Receipt;
  onClose: () => void;
  onResolve: (action: Resolution, expectedRevision?: string, mergedFiles?: SkillFile[]) => Promise<void>;
  documentKind?: "instructions";
}) {
  const [equipSkill, setEquipSkill] = useState(skill);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    if (!skill || (skill.files.length && (!receipt.revision || skill.versions.some(version =>
      version.revision === receipt.revision && version.files.length)))) return;
    let cancelled = false;
    void api<Skill>(documentKind === "instructions" ? `/instructions/${skill.id}` : `/skills/${skill.id}`)
      .then((complete) => { if (!cancelled) setEquipSkill(complete); })
      .catch((error) => { if (!cancelled) setLoadError((error as Error).message); });
    return () => { cancelled = true; };
  }, [skill?.id, receipt.revision, documentKind]);
  const comparisons = useMemo(
    () => skill && !equipSkill?.files.length ? [] : compareSkillFiles(receipt.localFiles || [], equipSkill?.files || [], device.os !== "win32"),
    [receipt.localFiles, equipSkill?.files, skill?.id, device.os],
  );
  const [selectedPath, setSelectedPath] = useState(comparisons[0]?.path);
  const baseline = useMemo(() => receipt.revision
    ? equipSkill?.versions.find(version => version.revision === receipt.revision)
    : undefined, [equipSkill?.versions, receipt.revision]);
  const merge = useMemo(() => mergeSkillFiles(
    baseline?.files.length ? baseline.files : undefined,
    receipt.localFiles || [],
    equipSkill?.files || [],
  ), [baseline?.files, receipt.localFiles, equipSkill?.files]);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeResolutions, setMergeResolutions] = useState<Record<string, SkillFile | undefined>>({});
  useEffect(() => { setMergeOpen(false); setMergeResolutions({}); }, [receipt.revision, equipSkill?.revision]);
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
  const executableChanges = comparisons.filter((file) => file.modeChanged).length;
  const contentChanges = comparisons.filter((file) => file.contentChanged).length;
  const comparisonReady = !skill || Boolean(equipSkill?.files.length);
  const queuedCopy = queued === "replace"
    ? "Equip will save the local version in history, then install its selected version."
    : queued === "publish"
      ? "Local version published to Equip. Selected destinations are applying that revision; completion requires receipts."
      : queued === "merge"
        ? "The reviewed merged folder was published to Equip. Selected destinations are applying that revision."
      : queued === "preserve"
        ? "This computer will keep its local version and stop updates for this installation."
        : documentKind === "instructions" ? "Equip will save the local instructions as the global draft. Published instructions stay unchanged." : "Equip will save the local files as a separate custom draft.";
  const latestReceipt = device.receipts.find(item => item.skillId === receipt.skillId && item.agent === receipt.agent && item.profile === receipt.profile && item.project === receipt.project);
  const excluded = skill?.targets.some(target => target.deviceId === device.id && target.agent === receipt.agent && target.profile === receipt.profile && target.project === receipt.project && !target.enabled);
  const completed = Boolean(queued && (
    queued === "preserve" || queued === "import"
      ? (!skill || excluded) && !latestReceipt
      : !skill ? !latestReceipt : latestReceipt?.status === "synchronized" && latestReceipt.revision === skill.revision
  ));

  const resolve = async (action: Resolution, mergedFiles?: SkillFile[]) => {
    if (!comparisonReady) return;
    setSubmitting(action);
    setResolveError("");
    try {
      await onResolve(action, skill ? equipSkill?.revision : undefined, mergedFiles);
      setQueued(action);
    } catch (error) {
      setResolveError((error as Error).message);
    } finally {
      setSubmitting(undefined);
    }
  };

  const resolvedMerge = merge.conflicts.every(conflict =>
    Object.prototype.hasOwnProperty.call(mergeResolutions, conflict.path) &&
    (mergeResolutions[conflict.path]?.encoding === "base64" ||
      !hasMergeMarkers(mergeResolutions[conflict.path]?.content ?? "")));
  const mergedFolder = () => [
    ...merge.files,
    ...merge.conflicts.flatMap(conflict => {
      const resolved = mergeResolutions[conflict.path];
      return resolved ? [resolved] : [];
    }),
  ].sort((a, b) => a.path.localeCompare(b.path));

  return (
    <Dialog title={`Review ${documentKind === "instructions" ? "instruction" : "skill"} conflict`} onClose={onClose} wide>
      <div className="conflict-dialog-body">
        <header className="conflict-summary">
          <div>
            <span className="conflict-kicker">{equipSkill?.title || receipt.skillId}</span>
            <h3>{device.name}</h3>
            <p>{scope || "Unknown agent location"}</p>
              {documentKind !== "instructions" && agent?.aliases && agent.aliases.length > 1 && (
              <p>{agent.aliases.map((alias) => alias.profile).join(", ")} share this physical skill folder.</p>
            )}
          </div>
          <dl>
            <div><dt>Local path</dt><dd><code title={receipt.path}>{receipt.path || "Path unavailable"}</code></dd></div>
            <div><dt>Last Equip baseline</dt><dd><code>{receipt.revision ? revision(receipt.revision) : "Unknown"}</code></dd></div>
            <div><dt>Equip revision</dt><dd><code>{revision(equipSkill?.revision || "")}</code></dd></div>
            <div><dt>Comparison basis</dt><dd>{receipt.revision ? "Previously compared with the recorded Equip baseline" : "No shared baseline; neither version is assumed newer"}</dd></div>
          </dl>
          <div className="conflict-counts" aria-label="Conflict summary">
            <strong>{comparisons.length}</strong><span>changed {comparisons.length === 1 ? "file" : "files"}</span>
            <strong>{contentChanges}</strong><span>content</span>
            <strong>{executableChanges}</strong><span>executable status</span>
          </div>
        </header>

        <div className="conflict-workbench">
          <nav className="conflict-files" aria-label="Changed files">
            <div className="conflict-pane-title">Changed files</div>
            {loadError && !equipSkill?.files.length ? <p className="conflict-empty">Could not load the Equip version: {loadError}</p> : skill && !equipSkill?.files.length ? <p className="conflict-empty">Loading the Equip version…</p> : comparisons.length ? comparisons.map((file) => (
              <button
                type="button"
                key={file.path}
                className={selected?.path === file.path ? "active" : ""}
                onClick={() => setSelectedPath(file.path)}
              >
                {file.status === "added" ? <FilePlus2 size={14} /> : file.status === "removed" ? <FileX2 size={14} /> : file.status === "permissions" ? <ShieldCheck size={14} /> : <FileCode2 size={14} />}
                <span><strong>{file.path}</strong><small>{file.status === "added" ? "Only in Equip" : file.status === "removed" ? "Only on this computer" : file.status === "permissions" ? "Executable status differs" : file.modeChanged ? "Content and executable status differ" : "Content differs"}</small></span>
              </button>
            )) : <p className="conflict-empty">The file details are unavailable for this receipt.</p>}
          </nav>

          <section className="conflict-diff" aria-label={selected ? `Differences in ${selected.path}` : "File differences"}>
            <div className="conflict-pane-title">
              <span>{selected?.path || "No file selected"}</span>
              {selected?.binary && <span>Binary file</span>}
              {selected?.modeChanged && <span>Local {selected.local && (selected.local.mode ?? 0o644) & 0o111 ? "executable" : "not executable"} · Equip {selected.equip && (selected.equip.mode ?? 0o644) & 0o111 ? "executable" : "not executable"}</span>}
            </div>
            {selected?.binary && selected.contentChanged ? (
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
              <div className="permission-diff"><ShieldCheck size={22} /><strong>Executable status differs</strong><p>Local: <code>{selected.local && (selected.local.mode ?? 0o644) & 0o111 ? "executable" : "not executable"}</code> · Equip: <code>{selected.equip && (selected.equip.mode ?? 0o644) & 0o111 ? "executable" : "not executable"}</code></p></div>
            ) : (
              <div className="binary-diff"><p>Select a changed file to inspect it.</p></div>
            )}
          </section>
        </div>

        <div className="conflict-legend"><span className="remove">Local removal</span><span className="add">Equip addition</span><span>Line numbers: local / Equip</span></div>

        {mergeOpen && (
          <section className="conflict-merge" aria-label="Resolve merged folder">
            <div className="conflict-pane-title"><span>Merge local and Equip changes</span><span>{merge.conflicts.length} manual {merge.conflicts.length === 1 ? "decision" : "decisions"}</span></div>
            {!merge.hasBase ? (
              <div className="notice"><AlertTriangle size={15} />No shared published baseline matches this receipt. Choose a complete version below, or save the local copy as a draft and edit it manually.</div>
            ) : merge.conflicts.map(conflict => {
              const hasResolution = Object.prototype.hasOwnProperty.call(mergeResolutions, conflict.path);
              const resolved = mergeResolutions[conflict.path];
              return <div className="conflict-merge-file" key={conflict.path}>
                <div><strong>{conflict.path}</strong><p>{conflict.message}</p></div>
                {conflict.kind === "text" && conflict.candidate ? (
                  <>
                    <textarea
                      className="file-preview"
                      aria-label={`Merged content for ${conflict.path}`}
                      value={hasResolution ? resolved?.content ?? "" : conflict.candidate.content}
                      onChange={event => setMergeResolutions(current => ({ ...current,
                        [conflict.path]: { ...conflict.candidate!, content: event.target.value } }))}
                    />
                    <small>Remove every LOCAL, BASE, and EQUIP marker after choosing the final text.</small>
                  </>
                ) : (
                  <div className="conflict-merge-sides">
                    <button type="button" className={hasResolution && resolved === conflict.local ? "active" : ""}
                      onClick={() => setMergeResolutions(current => ({ ...current, [conflict.path]: conflict.local }))}>
                      {conflict.local ? "Use local file" : "Keep local deletion"}
                    </button>
                    <button type="button" className={hasResolution && resolved === conflict.equip ? "active" : ""}
                      onClick={() => setMergeResolutions(current => ({ ...current, [conflict.path]: conflict.equip }))}>
                      {conflict.equip ? "Use Equip file" : "Keep Equip deletion"}
                    </button>
                  </div>
                )}
              </div>;
            })}
            {merge.hasBase && <button type="button" className="button primary" disabled={Boolean(submitting) || !resolvedMerge}
              onClick={() => void resolve("merge", mergedFolder())}>Publish merged folder</button>}
          </section>
        )}

        {queued ? (
          <div className="conflict-queued" role="status"><Check size={17} /><div><strong>{completed ? "Computer confirmed your choice" : queued === "publish" ? "Local version published" : queued === "merge" ? "Merged version published" : "Choice queued for this computer"}</strong><p>{completed ? "This installation has reconciled. Other selected destinations report their progress in Computers." : `${queuedCopy} The conflict stays visible until the computer reports completion.`}</p></div></div>
        ) : (
          <div className="conflict-choices">
            <button type="button" disabled={Boolean(submitting) || !comparisonReady || !skill || !receipt.localFiles?.length || !baseline?.files.length}
              onClick={() => merge.conflicts.length ? setMergeOpen(true) : void resolve("merge", merge.files)}><strong>Merge and publish everywhere</strong><span>{baseline?.files.length ? "Combine nonoverlapping edits from the local folder and Equip. Resolve overlapping text, binary files, deletions, and executable status before publishing." : "No shared published baseline matches this receipt. Choose a complete version or save a draft for manual editing."}</span></button>
            <button type="button" disabled={Boolean(submitting) || !comparisonReady} onClick={() => void resolve("replace")}><strong>{skill ? "Use Equip version" : "Save and remove"}</strong><span>{skill ? "Save the local version in Equip history, then link this agent to Equip’s revision." : `Equip removed this ${documentKind === "instructions" ? "document" : "skill"}. Save local edits in history, then remove this managed installation.`}</span></button>
            <button type="button" disabled={Boolean(submitting) || !comparisonReady || !receipt.localFiles?.length || !skill} onClick={() => void resolve("publish")}><strong>Use local version everywhere</strong><span>Publish this reviewed local {documentKind === "instructions" ? "file" : "folder snapshot"} to Equip and all selected destinations. Files on this computer are preserved.</span>{documentKind !== "instructions" && skill?.kind === "third-party" && <em>The upstream source stays connected. Automatic updates turn off.</em>}</button>
            <button type="button" disabled={Boolean(submitting) || !comparisonReady} onClick={() => void resolve("preserve")}><strong>Keep local on this computer</strong><span>Create an exception here and stop updates for this {documentKind === "instructions" ? "file" : "installation"}.</span></button>
            <button type="button" disabled={Boolean(submitting) || !comparisonReady || !receipt.localFiles?.length} onClick={() => void resolve("import")}><strong>{documentKind === "instructions" ? "Save local as global draft" : "Save local as custom draft"}</strong><span>{documentKind === "instructions" ? "Review this local copy in the global editor before publishing. Published instructions stay unchanged." : "Keep the local work in Equip as a separate unpublished draft."}</span></button>
          </div>
        )}
        {!receipt.localFiles?.length && <p className="conflict-note"><AlertTriangle size={14} /> Local file contents were not included in this receipt, so Equip cannot create a draft.</p>}
        {resolveError && <p className="conflict-resolution-error" role="alert"><AlertTriangle size={14} /> {resolveError}</p>}
      </div>
    </Dialog>
  );
}

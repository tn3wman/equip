import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, Check, ChevronDown, Clock3, Download, FileDown, FileText, Monitor, Plus, Save, Send, Trash2, Upload } from "lucide-react";
import type { Device, InstructionFilename, InstructionLocation, Instructions, Receipt, Target, Workspace } from "../shared/types";
import { instructionDeployment, instructionEnabled, instructionsAsSkill } from "../shared/instructions";
import { reviewedFilesRevision } from "../shared/conflicts";
import { api } from "./api";
import { ago, Dialog, revision } from "./components";
import SkillConflict from "./SkillConflict";

type Props = { workspace: Workspace; refresh: () => Promise<void>; notify: (message: string) => void };
type FullInstruction = Instructions;

const emptyContent = "# Instructions\n\nDescribe how your coding agents should work.\n";
const locationId = (deviceId: string, location: InstructionLocation) =>
  [deviceId, location.agent, location.profile ?? "", location.project ?? "", location.filename].join(":");

function targetFor(deviceId: string, location: InstructionLocation, enabled: boolean): Target {
  return { deviceId, agent: location.agent, ...(location.profile ? { profile: location.profile } : {}), ...(location.project ? { project: location.project } : {}), enabled };
}

export default function InstructionsPage({ workspace, refresh, notify }: Props) {
  const documents = workspace.instructions ?? [];
  const [selectedId, setSelectedId] = useState<string | undefined>(() => documents[0]?.id);
  const [document, setDocument] = useState<FullInstruction>();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState(emptyContent);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [conflict, setConflict] = useState<{ device: Device; receipt: Receipt }>();
  const [importSelection, setImportSelection] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selectedId && !documents.some((item) => item.id === selectedId)) setSelectedId(documents[0]?.id);
    if (!selectedId && documents.length) setSelectedId(documents[0].id);
  }, [documents, selectedId]);

  useEffect(() => {
    if (!selectedId) { setDocument(undefined); return; }
    let cancelled = false;
    setError("");
    void api<FullInstruction>(`/instructions/${selectedId}`).then((result) => {
      if (cancelled) return;
      setDocument(result);
      setTitle(result.title);
      setContent((result.draft ?? result.files)[0]?.content ?? "");
    }).catch((cause) => { if (!cancelled) setError((cause as Error).message); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const locations = useMemo(() => workspace.devices.flatMap((device) =>
    (device.instructionLocations ?? []).filter((location) => !location.project)
      .map((location) => ({ device, location }))), [workspace.devices]);
  const importLocations = useMemo(() => workspace.devices.flatMap((device) =>
    (device.instructionLocations ?? []).filter((location) => location.localFiles?.length)
      .map((location) => ({ device, location }))), [workspace.devices]);
  const unavailable = useMemo(() => workspace.devices.flatMap((device) =>
    (device.instructionUnavailable ?? []).map((item) => ({ device, ...item }))), [workspace.devices]);
  const workspaceDocument = selectedId ? documents.find((item) => item.id === selectedId) : undefined;
  const deployment = workspaceDocument ? instructionDeployment(workspaceDocument, workspace.devices) : undefined;
  const dirty = Boolean(document && (title !== document.title || content !== (document.draft ?? document.files)[0]?.content));

  async function run(label: string, work: () => Promise<unknown>, message: string) {
    setBusy(label); setError("");
    try { await work(); await refresh(); notify(message); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(""); }
  }
  async function reloadPublished() {
    if (!selectedId) return;
    setBusy("reload"); setError("");
    try {
      const result = await api<FullInstruction>(`/instructions/${selectedId}`);
      setDocument(result); setTitle(result.title); setContent((result.draft ?? result.files)[0]?.content ?? "");
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(""); }
  }
  function selectDocument(id: string) {
    if (id === selectedId) return;
    if (dirty && !confirm("Discard unsaved changes and open another draft?")) return;
    setDocument(undefined);
    setSelectedId(id);
  }
  async function create() {
    await run("create", async () => {
      const created = await api<Instructions>("/instructions", "POST", { title: "Global instructions", filename: "AGENTS.md", scope: "global", files: [{ path: "AGENTS.md", content: emptyContent }] });
      setSelectedId(created.id); setDocument(created); setTitle(created.title); setContent((created.draft ?? created.files)[0]?.content ?? "");
    }, "Instruction draft created.");
  }
  async function save() {
    if (!document) return;
    await run("save", async () => {
      const result = await api<Instructions>(`/instructions/${document.id}`, "PATCH", { title, draft: [{ path: "AGENTS.md", content }], expectedRevision: document.revision });
      setDocument(result);
    }, "Draft saved. Published instructions are unchanged.");
  }
  async function publish() {
    if (!document) return;
    await run("publish", async () => {
      if (dirty) await api(`/instructions/${document.id}`, "PATCH", { title, draft: [{ path: "AGENTS.md", content }], expectedRevision: document.revision });
      const result = await api<Instructions>(`/instructions/${document.id}/publish`, "POST", { files: [{ path: "AGENTS.md", content }], expectedRevision: document.revision, message: "Published from the instruction editor" });
      setDocument(result); setContent(result.files[0]?.content ?? ""); setTitle(result.title);
    }, "Instructions published. Connected computers will apply this revision.");
  }
  async function setEnabled(enabled: boolean) {
    if (!document) return;
    await run("enabled", async () => { const result = await api<Instructions>(`/instructions/${document.id}`, "PATCH", { enabled, expectedRevision: document.revision }); setDocument(result); }, enabled ? "Instructions enabled." : "Instructions disabled. Managed copies will be removed.");
  }
  async function toggleLocation(device: Device, location: InstructionLocation, enabled: boolean) {
    if (!document) return;
    const targets = document.targets.filter((target) => !(target.deviceId === device.id && target.agent === location.agent && target.profile === location.profile && target.project === location.project));
    targets.push(targetFor(device.id, location, enabled));
    await run("target", async () => { const result = await api<Instructions>(`/instructions/${document.id}`, "PATCH", { targets, expectedRevision: document.revision }); setDocument(result); }, enabled ? "Location included." : "Location excluded. Managed content will be removed there.");
  }
  async function remove() {
    if (!document || !confirm(`Delete “${document.title}”? Managed copies will be removed from selected locations.`)) return;
    await run("delete", async () => { await api(`/instructions/${document.id}`, "DELETE"); setSelectedId(undefined); setDocument(undefined); }, "Instructions deleted.");
  }
  async function rollback(versionId: string) {
    if (!document) return;
    await run("rollback", async () => { const result = await api<Instructions>(`/instructions/${document.id}/rollback`, "POST", { versionId, expectedRevision: document.revision }); setDocument(result); setContent(result.files[0]?.content ?? ""); }, "Earlier version restored and published.");
  }
  async function importComputer() {
    const item = importLocations.find(({ device, location }) => locationId(device.id, location) === importSelection);
    if (!item?.location.localFiles?.length) return;
    await run("import", async () => {
      const expectedLocalRevision = await reviewedFilesRevision(item.location.localFiles!);
      const created = await api<Instructions>("/instructions/import", "POST", { deviceId: item.device.id, path: item.location.path, expectedLocalRevision, instructionId: document?.id, expectedRevision: document?.revision });
      setSelectedId(created.id); setDocument(created); setTitle(created.title); setContent((created.draft ?? created.files)[0]?.content ?? "");
      setImportOpen(false);
    }, "Computer copy imported as a draft.");
  }
  async function browserImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    if (dirty && !confirm("Discard unsaved changes and import this file?")) { event.target.value = ""; return; }
    const text = await file.text();
    await run("browser-import", async () => {
      const current = document ?? documents[0];
      const created = current
        ? await api<Instructions>(`/instructions/${current.id}`, "PATCH", { title: file.name, draft: [{ path: "AGENTS.md", content: text }], expectedRevision: current.revision })
        : await api<Instructions>("/instructions", "POST", { title: file.name, filename: "AGENTS.md", scope: "global", files: [{ path: "AGENTS.md", content: text }] });
      setSelectedId(created.id); setDocument(created); setTitle(created.title); setContent((created.draft ?? created.files)[0]?.content ?? "");
    }, `${file.name} imported as a draft.`);
    event.target.value = "";
  }
  function download() {
    const text = content || (workspaceDocument?.files[0]?.content ?? "");
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const link = globalThis.document.createElement("a");
    link.href = url; link.download = "AGENTS.md"; link.click();
    URL.revokeObjectURL(url);
  }

  return <div className="instructions-page">
    <header className="instructions-heading">
      <div><h1>Instructions</h1><p>Write the guidance your agents carry into every project.</p></div>
      <div className="instructions-actions">
        <input ref={fileInput} hidden type="file" accept=".md,text/markdown,text/plain" onChange={(event) => void browserImport(event)} />
        <button className="button" onClick={() => fileInput.current?.click()}><Upload size={15} /> Import file</button>
        <button className="button" onClick={() => { if (!dirty || confirm("Discard unsaved changes and import from a computer?")) setImportOpen(true); }}><FileDown size={15} /> Import from computer</button>
        <button className="button" onClick={download} disabled={!document}><Download size={15} /> Download AGENTS.md</button>
        {!documents.length && <button className="button primary" onClick={() => void create()} disabled={Boolean(busy)}><Plus size={16} /> Create instructions</button>}
      </div>
    </header>
    {error && <div className="notice error" role="alert"><AlertTriangle size={16} />{error}{/revision changed/i.test(error) && <button onClick={() => void reloadPublished()}>Reload published version</button>}</div>}
    <div className="instructions-workbench">
      <aside className="instruction-rail" aria-label="Instruction documents">
        {documents.map((item) => {
          const state = instructionDeployment(item, workspace.devices);
          return <button key={item.id} className={item.id === selectedId ? "active" : ""} onClick={() => selectDocument(item.id)}>
            <FileText size={18} /><span><strong>{item.title}</strong><small>Global · all agents</small></span><i className={`instruction-state ${state.status}`} title={state.status} />
          </button>;
        })}
        {!documents.length && <div className="instruction-empty"><FileText size={24} /><strong>No instructions yet</strong><p>Create a document or import one from a connected computer.</p></div>}
      </aside>
      {document ? <section className="instruction-editor">
        <div className="instruction-meta">
          <label className="instruction-title"><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <div className="instruction-native"><span>Native files</span><strong>Same content, agent-native names</strong></div>
          <div className="instruction-native"><span>Scope</span><strong>Global</strong></div>
          <div className="instruction-publish-state"><span className={`status-dot ${document.enabled ? "on" : ""}`} />{document.versions.length ? document.enabled ? "Published" : "Disabled" : "Draft"}</div>
        </div>
        <div className="instruction-toolbar">
          <div role="tablist" aria-label="Editor view"><button className={!preview ? "active" : ""} onClick={() => setPreview(false)} role="tab" aria-selected={!preview}>Write</button><button className={preview ? "active" : ""} onClick={() => setPreview(true)} role="tab" aria-selected={preview}>Preview</button></div>
          <span>{content.length.toLocaleString()} characters</span>
          <button onClick={() => setHistoryOpen(!historyOpen)}><Clock3 size={15} /> History <ChevronDown size={14} /></button>
        </div>
        {preview ? <article className="instruction-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></article> : <textarea className="instruction-textarea" spellCheck value={content} onChange={(event) => setContent(event.target.value)} aria-label="Markdown instructions" />}
        <footer className="instruction-editor-footer">
          <button className="button danger-text" onClick={() => void remove()} disabled={Boolean(busy)}><Trash2 size={15} /> Delete</button>
          <span>{dirty ? "Unsaved changes" : `Updated ${ago(document.updatedAt)}`}</span>
          <button className="button" onClick={() => void setEnabled(!document.enabled)} disabled={Boolean(busy) || !document.versions.length}>{document.enabled ? "Disable" : "Enable"}</button>
          <button className="button" onClick={() => void save()} disabled={!dirty || Boolean(busy)}><Save size={15} /> Save draft</button>
          <button className="button primary" onClick={() => void publish()} disabled={!content.trim() || Boolean(busy)}><Send size={15} /> Publish</button>
        </footer>
        {historyOpen && <div className="instruction-history"><h2>Version history</h2>{document.versions.map((version) => <div key={version.id}><span><strong>{version.message || "Published version"}</strong><small>{ago(version.createdAt)} · {revision(version.revision)}</small></span><details><summary>Preview</summary><ReactMarkdown remarkPlugins={[remarkGfm]}>{version.files[0]?.content ?? ""}</ReactMarkdown></details><button onClick={() => void rollback(version.id)} disabled={Boolean(busy)}>Restore</button></div>)}</div>}
      </section> : <section className="instruction-welcome"><FileText size={34} /><h2>One instruction set, every agent</h2><p>Equip publishes one global revision in each supported agent’s native instruction file.</p><button className="button primary" onClick={() => void create()}><Plus size={16} /> Create instructions</button></section>}
      <aside className="instruction-deployment" aria-label="Deployment locations">
        <div className="deployment-title"><span><Monitor size={17} /><strong>Locations</strong></span>{deployment && <small>{deployment.complete} of {deployment.total} applied{unavailable.length ? ` · ${unavailable.length} unavailable` : ""}</small>}</div>
        <p className="project-registration">Projects may add their own <code>AGENTS.md</code> for additional context. Equip does not write project files.</p>
        {locations.map(({ device, location }) => {
          const enabled = document ? instructionEnabled(document, location, device.id) : true;
          const receipt = workspaceDocument && device.receipts.find((item) => item.kind === "instructions" && item.skillId === workspaceDocument.id && item.agent === location.agent && item.profile === location.profile && item.project === location.project);
          const applied = receipt?.status === "synchronized" && receipt.revision === workspaceDocument?.revision;
          return <div className="instruction-location" key={locationId(device.id, location)}>
            <label><input type="checkbox" checked={enabled} disabled={!document || Boolean(busy)} onChange={(event) => void toggleLocation(device, location, event.target.checked)} /><span><strong>{device.name}</strong><small>{[location.agent, location.profile, location.filename].filter(Boolean).join(" · ")}</small></span></label>
            <code title={location.path}>{location.path}</code>
            <p className={applied ? "synchronized" : receipt?.status === "failed" || receipt?.status === "conflicted" ? receipt.status : !device.online ? "offline" : "pending"}>{!enabled ? "Excluded from global instructions" : applied ? <><Check size={13} /> Applied {ago(receipt!.timestamp)}</> : receipt?.status === "synchronized" ? "Waiting for the current revision" : receipt?.message || location.warning || (!device.online ? "Computer offline" : "Waiting for receipt")}</p>
            {enabled && receipt?.status === "conflicted" && <button className="instruction-review" onClick={() => setConflict({ device, receipt })}>Review conflict</button>}
          </div>;
        })}
        {!!unavailable.length && <details className="instruction-unavailable"><summary>{unavailable.length} unavailable integrations</summary>{unavailable.map(({ device, agent, reason }) => <div className="instruction-location unavailable" key={`${device.id}:${agent}`}><strong>{device.name}</strong><small>{agent} · unavailable</small><p><AlertTriangle size={13} />{reason}</p></div>)}</details>}
        {!locations.length && <p className="deployment-empty">{workspace.devices.some((device) => device.instructionLocations === undefined) ? "Connected computers need a newer Equip worker before instructions can sync." : "No compatible locations were found for this file and scope."}</p>}
      </aside>
    </div>
    {conflict && <SkillConflict documentKind="instructions" skill={workspaceDocument ? instructionsAsSkill(workspaceDocument) : undefined}
      device={workspace.devices.find(item => item.id === conflict.device.id) ?? conflict.device} receipt={conflict.receipt}
      onClose={() => setConflict(undefined)} onResolve={async (action, expectedRevision, mergedFiles) => {
        await api(`/devices/${conflict.device.id}/instructions/resolve`, "POST", {
          instructionId: conflict.receipt.skillId, agent: conflict.receipt.agent, profile: conflict.receipt.profile,
          action, expectedRevision, mergedFiles, expectedLocalRevision: conflict.receipt.localFiles ? await reviewedFilesRevision(conflict.receipt.localFiles) : undefined,
        });
        await refresh(); notify(action === "publish" ? "Local version published. Waiting for device receipts." : "Choice queued. Waiting for the computer receipt.");
      }} />}
    {importOpen && <Dialog title="Import from a computer" onClose={() => setImportOpen(false)} wide><div className="instruction-import"><p>Review the complete detected instruction file, then save it as the shared global draft.</p>{error && <div className="notice error" role="alert"><AlertTriangle size={16} />{error}</div>}<div>{importLocations.map(({ device, location }) => { const id = locationId(device.id, location); return <label key={id} className={importSelection === id ? "selected" : ""}><input type="radio" name="computer-file" value={id} checked={importSelection === id} onChange={() => setImportSelection(id)} /><span><strong>{device.name} · {location.filename}</strong><code>{location.path}</code><pre>{location.localFiles?.[0]?.content}</pre></span></label>; })}{!importLocations.length && <p className="deployment-empty">No readable instruction files have been reported by connected computers.</p>}</div><footer><button className="button" onClick={() => setImportOpen(false)}>Cancel</button><button className="button primary" disabled={!importSelection || Boolean(busy)} onClick={() => void importComputer()}>Import draft</button></footer></div></Dialog>}
  </div>;
}

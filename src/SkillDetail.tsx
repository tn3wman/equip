import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  X,
  ArrowUpRight,
  GitFork as Github,
  Check,
  FileText,
  Folder,
  RefreshCw,
  Clock3,
  Code2,
  ArrowDownToLine,
  Pencil,
  Trash2,
  RotateCcw,
  Loader2,
  AlertTriangle,
  ChevronRight,
  Eye,
  Terminal,
} from "lucide-react";
import { api } from "./api";
import {
  Dialog,
  SkillIcon,
  Status,
  revision,
  ago,
  navigateTabs,
} from "./components";
import type { Skill, Workspace, SkillFile, Target } from "../shared/types";
import type { SkillSafety } from "../shared/types";
import { SafetyBadge, SafetyReport } from "./Safety";

export default function SkillDetail({
  skill,
  workspace,
  onClose,
  onEdit,
  onChange,
  notify,
}: {
  skill: Skill;
  workspace: Workspace;
  onClose: () => void;
  onEdit: (s: Skill) => void;
  onChange: () => Promise<void>;
  notify: (m: string) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [tab, setTab] = useState("instructions");
  const [file, setFile] = useState("SKILL.md");
  const [actual, setActual] = useState<Skill>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<"remove" | "rollback" | null>(null);
  const [versionId, setVersionId] = useState("");
  const [safety, setSafety] = useState<SkillSafety | undefined>(skill.safety);
  const [safetyLoading, setSafetyLoading] = useState(skill.kind === "third-party");
  const [auditAcknowledged, setAuditAcknowledged] = useState(false);
  const installed = workspace.skills.some(
    (s) => s.id === skill.id && s.selected,
  );
  const devices = workspace.devices.filter((device) => !device.disconnectedAt);
  const data = actual || skill;
  const flagged = safety?.status === "warn" || safety?.status === "fail";
  const files = data.files.length ? data.files : data.draft || [];
  const activeFile = files.find((f) => f.path === file) || files[0];
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    panel.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (document.querySelector(".overlay")) return;
      if (e.key === "Escape") close.current();
      if (e.key === "Tab") {
        const nodes = panel.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,select,a[href],[tabindex="0"]',
        );
        if (!nodes?.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === panel.current)
        ) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    if (!installed) return;
    let disposed = false;
    setLoading(true);
    setError("");
    api<Skill>(`/skills/${skill.id}`).then(value => { if (!disposed) setActual(value); }).catch(error => { if (!disposed) setError(error.message); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [skill.id, skill.revision, installed]);
  useEffect(() => {
    if (skill.kind !== "third-party") return;
    let disposed = false;
    setSafetyLoading(true);
    setAuditAcknowledged(false);
    api<SkillSafety>(`/skills/audits?source=${encodeURIComponent(skill.source)}&name=${encodeURIComponent(skill.name)}`)
      .then((result) => { if (!disposed) setSafety(result); })
      .catch((requestError) => { if (!disposed) setSafety({ status: "unavailable", audits: [], checkedAt: new Date().toISOString(), error: requestError.message, scope: "upstream" }); })
      .finally(() => { if (!disposed) setSafetyLoading(false); });
    return () => { disposed = true; };
  }, [skill.source, skill.name, skill.kind, skill.revision]);
  const act = async (
    fn: () => Promise<any>,
    message: string,
    close = false,
  ) => {
    setBusy(true);
    setError("");
    try {
      const result = await fn();
      await onChange();
      notify(result?.pending ? "Waiting for a connected computer to resolve this source. The selected revision will change after Equip accepts it." : message);
      if (close) onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const inspect = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api<Skill>("/skills/inspect", "POST", {
        source: skill.source,
        name: skill.name,
      });
      setActual({ ...skill, ...result });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const updateTargets = async (
    deviceId: string,
    agent: string,
    enabled: boolean,
    profile?: string,
    project?: string,
  ) => {
    const targets = skill.targets.filter(
      (t) =>
        !(
          t.deviceId === deviceId &&
          t.agent === agent &&
          t.profile === profile &&
          t.project === project
        ),
    );
    if (!enabled)
      targets.push({ deviceId, agent, profile, project, enabled: false });
    await act(
      () => api(`/skills/${skill.id}`, "PATCH", { targets }),
      "Destination preferences saved. Devices will confirm the change.",
    );
  };
  return (
    <>
      <div
        className="detail-backdrop"
        onMouseDown={(e) => {
          if (e.currentTarget === e.target) onClose();
        }}
      />
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="detail-panel"
        aria-label={`${skill.title} details`}
      >
        <div className="detail-topbar">
          <span>SKILL DETAILS</span>
          <button
            className="icon-button"
            aria-label="Close skill details"
            onClick={onClose}
          >
            <X size={21} />
          </button>
        </div>
        <div className="detail-heading">
          <SkillIcon skill={skill} />
          <h2>{data.title}</h2>
          <p>{data.description}</p>
          <div className="detail-byline">
            {skill.kind === "custom" ? (
              <>
                <Pencil size={13} />
                Custom skill
              </>
            ) : (
              <>
                <Github size={13} />
                {skill.source}
                <a
                  href={
                    skill.source.startsWith("http")
                      ? skill.source
                      : `https://github.com/${skill.source.split("@")[0]}`
                  }
                  target="_blank"
                  rel="noreferrer"
                  aria-label="View source repository"
                >
                  <ArrowUpRight size={13} />
                </a>
              </>
            )}
            {installed && (
              <Status
                status={skill.versions.length ? "connected" : "draft"}
                label={skill.versions.length ? "In your library" : "Draft"}
              />
            )}
            {skill.kind === "third-party" && <SafetyBadge safety={safety} loading={safetyLoading} />}
          </div>
          <div className="detail-actions">
            {installed ? (
              <>
                {skill.kind === "custom" ? (
                  <button
                    className="button primary"
                    disabled={loading} onClick={() => onEdit(data)}
                  >
                    <Pencil size={15} />
                    Edit skill
                  </button>
                ) : (
                  <button
                    className="button primary"
                    disabled={busy || safetyLoading || (flagged && !auditAcknowledged)}
                    onClick={() =>
                      act(
                        () => api(`/skills/${skill.id}/update`, "POST", auditAcknowledged ? { auditAcknowledged: true } : undefined),
                        "Updated revision selected. Computers will confirm installation.",
                      )
                    }
                  >
                    {busy ? (
                      <Loader2 className="spin" size={15} />
                    ) : (
                      <RefreshCw size={15} />
                    )}
                    Update skill
                  </button>
                )}
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () =>
                        api(`/skills/${skill.id}`, "PATCH", {
                          enabled: !skill.enabled,
                        }),
                      skill.enabled
                        ? "Skill disabled. Managed installations will be removed."
                        : "Skill enabled. Computers will install the selected revision.",
                    )
                  }
                >
                  {skill.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  className="icon-button danger"
                  aria-label="Remove skill"
                  onClick={() => setConfirm("remove")}
                >
                  <Trash2 size={17} />
                </button>
              </>
            ) : (
              <button
                className="button primary"
                disabled={busy || safetyLoading || (flagged && !auditAcknowledged)}
                onClick={() =>
                  act(
                    () =>
                      api("/skills/install", "POST", {
                        source: skill.source,
                        name: skill.name,
                        ...(auditAcknowledged ? { auditAcknowledged: true } : {}),
                      }),
                    "Skill added. Connected computers will receive the selected revision.",
                    true,
                  )
                }
              >
                {busy ? <Loader2 className="spin" size={15} /> : <PlusIcon />}
                Add to your library
              </button>
            )}
          </div>
          {skill.kind === "third-party" && flagged && !safetyLoading && <><button className="text-link" onClick={() => setTab("security")}>Review security reports <ArrowUpRight size={13} /></button><label className="audit-acknowledgement"><input type="checkbox" checked={auditAcknowledged} onChange={(event) => setAuditAcknowledged(event.target.checked)} /><span><strong>I reviewed the audit findings</strong><small>Required before {installed ? "updating" : "adding"} this skill.</small></span></label></>}
        </div>
        {error && (
          <div className="notice error" role="alert">
            <AlertTriangle size={15} />
            {error}
          </div>
        )}
        {!installed && (
          <div className="inspect-source-note">
            <Eye size={17} />
            <span>
              {files.length
                ? "Showing the resolved source files."
                : "Catalog descriptions are a starting point. Load the source to inspect its actual files."}
            </span>
            <button className="text-link" disabled={loading} onClick={inspect}>
              {loading ? "Loading…" : actual ? "Reload" : "Load source"}
              <ArrowUpRight size={13} />
            </button>
          </div>
        )}
        {installed && skill.revision && <div className="detail-actions"><a className="button small" href={`/api/skills/${skill.id}/export?revision=${encodeURIComponent(skill.revision)}`} download><ArrowDownToLine size={14} /> Download ZIP {revision(skill.revision)}</a></div>}
        {installed && loading && <div className="catalog-loading" role="status"><Loader2 className="spin" size={16} /> Loading skill files…</div>}
        <div
          className="tabs detail-tabs"
          role="tablist"
          onKeyDown={navigateTabs}
          aria-label="Skill details"
        >
          {[
            { id: "instructions", label: "Instructions" },
            { id: "files", label: `Files (${files.length})` },
            ...(installed
              ? [
                  { id: "destinations", label: "Destinations" },
                  { id: "history", label: "History" },
                ]
              : []),
            ...(skill.kind === "third-party" ? [{ id: "security", label: "Security" }] : []),
          ].map((t) => (
            <button
              role="tab"
              tabIndex={tab === t.id ? 0 : -1}
              aria-selected={tab === t.id}
              className={tab === t.id ? "active" : ""}
              key={t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div
          className="detail-content"
          tabIndex={0}
          role="tabpanel"
          aria-label={tab}
        >
          {tab === "instructions" && (
            <>
              <div className="skill-metadata">
                <div>
                  <span>
                    {installed ? "Selected revision" : "Source revision"}
                  </span>
                  <code>{revision(data.revision)}</code>
                </div>
                <div>
                  <span>Format</span>
                  <strong>Agent Skills</strong>
                </div>
              </div>
              {data.requirements.length > 0 && (
                <div className="requirement-box">
                  <Terminal size={16} />
                  <div>
                    <strong>Requirements</strong>
                    <p>{data.requirements.join(" · ")}</p>
                  </div>
                </div>
              )}
              <div className="markdown">
                <Markdown remarkPlugins={[remarkGfm]}>
                  {(
                    files.find((f) => f.path === "SKILL.md")?.content ||
                    "No published instructions yet. Open the editor to publish this draft."
                  ).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")}
                </Markdown>
              </div>
            </>
          )}
          {tab === "files" && (
            <div className="file-inspector">
              <div className="file-list">
                {files.map((f) => (
                  <button
                    key={f.path}
                    className={file === f.path ? "active" : ""}
                    onClick={() => setFile(f.path)}
                  >
                    {f.path.includes("/") ? (
                      <Folder size={14} />
                    ) : (
                      <FileText size={14} />
                    )}
                    <span>{f.path}</span>
                    <ChevronRight size={12} />
                  </button>
                ))}
              </div>
              {activeFile && (
                <>
                  <div className="file-preview-header">
                    <code>{activeFile.path}</code>
                    <span>
                      {activeFile.mode && activeFile.mode & 0o111
                        ? "Executable"
                        : "File"}
                    </span>
                  </div>
                  {activeFile.encoding === "base64" ? (
                    <p className="muted-copy">
                      Binary asset ·{" "}
                      {Math.round((activeFile.content.length * 0.75) / 1024)} KB
                    </p>
                  ) : (
                    <pre className="file-preview">{activeFile.content}</pre>
                  )}
                </>
              )}
            </div>
          )}
          {tab === "security" && <SafetyReport safety={safety} loading={safetyLoading} />}
          {tab === "destinations" && (
            <>
              <h3 className="detail-section-title">
                Every computer, by default.
              </h3>
              <p className="muted-copy">
                New computers and newly detected agents receive this skill
                automatically. Turn off a destination to make an exception.
              </p>
              {devices.map((device) => (
                <div className="target-device" key={device.id}>
                  <div>
                    <strong>{device.name}</strong>
                    <Status status={device.online ? "connected" : "offline"} />
                  </div>
                  {device.agents.map((agent, i) => {
                    const disabled = skill.targets.some(
                      (t) =>
                        t.deviceId === device.id &&
                        t.agent === agent.id &&
                        (!t.profile || t.profile === agent.profile) &&
                        (!t.project || t.project === agent.project) &&
                        !t.enabled,
                    );
                    const receipt = device.receipts.find(
                      (r) =>
                        r.skillId === skill.id &&
                        r.agent === agent.id &&
                        r.profile === agent.profile &&
                        r.project === agent.project,
                    );
                    return (
                      <label className="target-agent" key={i}>
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked={!disabled}
                          onChange={(e) =>
                            updateTargets(
                              device.id,
                              agent.id,
                              e.target.checked,
                              agent.profile,
                              agent.project,
                            )
                          }
                        />
                        <span>
                          <strong>{agent.name}</strong>
                          {agent.aliases?.length ? <small>{agent.aliases.map(alias => alias.profile).join(", ")} share this folder</small> : null}
                          <code>{agent.path}</code>
                        </span>
                        <Status
                          status={
                            disabled ? "disabled" : receipt?.status || "pending"
                          }
                        />
                      </label>
                    );
                  })}
                </div>
              ))}
              {!devices.length && (
                <p className="muted-copy">
                  No computers connected yet. Your first connection will receive
                  this skill.
                </p>
              )}
              <div className="requirement-box">
                <Folder size={16} />
                <div>
                  <strong>Project installations & profiles</strong>
                  <p>
                    Register a project with{" "}
                    <code>
                      equip project add /path/to/project --agent codex
                    </code>{" "}
                    or a profile with{" "}
                    <code>
                      equip profile add work --agent claude-code --path
                      /custom/skills
                    </code>
                    . Registered destinations appear after the next sync.
                  </p>
                </div>
              </div>
            </>
          )}
          {tab === "history" && (
            <>
              {skill.kind === "third-party" && (
                <div className="update-setting">
                  <div>
                    <h3>Automatic updates</h3>
                    <p>
                      Allow Equip to select and deploy new upstream revisions.
                      You can roll back at any time.
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={skill.autoUpdate}
                    aria-label="Automatic updates"
                    className={`switch ${skill.autoUpdate ? "on" : ""}`}
                    disabled={busy}
                    onClick={() =>
                      act(
                        () =>
                          api(`/skills/${skill.id}`, "PATCH", {
                            autoUpdate: !skill.autoUpdate,
                          }),
                        !skill.autoUpdate
                          ? "Automatic updates enabled."
                          : "Updates now require your approval.",
                      )
                    }
                  >
                    <span />
                  </button>
                </div>
              )}
              {skill.kind === "third-party" && (
                <button
                  className="button small"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () => api(`/skills/${skill.id}/check`, "POST"),
                      "Upstream check complete.",
                    )
                  }
                >
                  <RefreshCw size={14} />
                  Check for updates
                </button>
              )}
              <h3 className="detail-section-title">Published versions</h3>
              {skill.draft && (
                <div className="draft-note">
                  <Pencil size={15} />
                  Unpublished changes are saved. Your computers keep the
                  published version.
                </div>
              )}
              {skill.versions.map((v, i) => (
                <div className="version-row" key={v.id}>
                  <span className="version-dot" />
                  <div>
                    <strong>{v.message}</strong>
                    <span>
                      <code>{revision(v.revision)}</code> · {ago(v.createdAt)}
                    </span>
                  </div>
                  {v.revision === skill.revision ? (
                    <span className="custom-tag">Selected</span>
                  ) : (
                    <button
                      className="button small"
                      onClick={() => {
                        setVersionId(v.id);
                        setConfirm("rollback");
                      }}
                    >
                      <RotateCcw size={13} />
                      Roll back
                    </button>
                  )}
                </div>
              ))}
              {!skill.versions.length && (
                <p className="muted-copy">
                  Publish your draft to create the first version.
                </p>
              )}
            </>
          )}
        </div>
        <div className="detail-bottom">
          <Check size={14} />
          <span>
            Complete folders. Consistent revisions. Confirmed receipts.
          </span>
        </div>
      </section>
      {confirm && (
        <Dialog
          title={
            confirm === "remove"
              ? "Remove this skill?"
              : "Roll back this skill?"
          }
          onClose={() => setConfirm(null)}
        >
          <div className="dialog-body">
            <p>
              {confirm === "remove"
                ? `${skill.title} will leave your library. Connected computers remove unchanged Equip-managed installations; offline computers follow when they reconnect. Local edits and preexisting folders or links are preserved.`
                : "The selected version will become the desired revision for every destination. Offline computers catch up when they reconnect, and local edits still require your decision."}
            </p>
            <div className="dialog-actions">
              <button className="button" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className={`button ${confirm === "remove" ? "danger-button" : "primary"}`}
                disabled={busy}
                onClick={() =>
                  act(
                    () =>
                      confirm === "remove"
                        ? api(`/skills/${skill.id}`, "DELETE")
                        : api(`/skills/${skill.id}/rollback`, "POST", {
                            versionId,
                          }),
                    confirm === "remove"
                      ? "Skill removed. Devices will confirm cleanup."
                      : "Previous revision selected. Devices will confirm rollback.",
                    confirm === "remove",
                  ).then(() => setConfirm(null))
                }
              >
                {busy ? <Loader2 className="spin" size={15} /> : null}
                {confirm === "remove" ? "Remove skill" : "Confirm rollback"}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
function PlusIcon() {
  return <ArrowDownToLine size={16} />;
}

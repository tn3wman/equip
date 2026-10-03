import { useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import YAML from "yaml";
import {
  ArrowLeft,
  Plus,
  FileText,
  Folder,
  Check,
  AlertTriangle,
  Eye,
  Code2,
  Sparkles,
  GitFork as Github,
  Upload,
  Loader2,
  Save,
  ArrowUpRight,
  Trash2,
} from "lucide-react";
import { api } from "./api";
import type { Skill, SkillFile } from "../shared/types";

const starter: SkillFile[] = [
  {
    path: "SKILL.md",
    content:
      "---\nname: my-skill\ndescription: Describe when an agent should use this skill.\n---\n\n# My skill\n\n## Instructions\n\n1. Understand the task and inspect the relevant files.\n2. Follow the workflow described here.\n3. Verify the result before reporting completion.\n",
    mode: 0o644,
  },
];
export default function Editor({
  skill,
  onSaved,
  onPublished,
  onQueued,
  onCancel,
}: {
  skill?: Skill;
  onSaved: (s: Skill) => Promise<void>;
  onPublished: () => Promise<void>;
  onQueued: () => Promise<void>;
  onCancel: () => void;
}) {
  const [current, setCurrent] = useState(skill);
  const [files, setFiles] = useState<SkillFile[]>(
    skill?.draft || skill?.files || starter,
  );
  const [active, setActive] = useState("SKILL.md");
  const [preview, setPreview] = useState(false);
  const [title, setTitle] = useState(skill?.title || "");
  const [mode, setMode] = useState("scratch");
  const [workflow, setWorkflow] = useState("");
  const [source, setSource] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [newFile, setNewFile] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [assistedDraft, setAssistedDraft] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const assets = useRef<HTMLInputElement>(null);
  const file = files.find((f) => f.path === active) || files[0];
  let metadata: any = {};
  let validation = "";
  try {
    const front = files
      .find((f) => f.path === "SKILL.md")
      ?.content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!front) validation = "Add YAML frontmatter with name and description.";
    else {
      metadata = YAML.parse(front[1]);
      if (
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata?.name || "") ||
        metadata.name.length > 64
      )
        validation =
          "Use a lowercase skill name with letters, numbers, and hyphens.";
      else if (
        typeof metadata.description !== "string" ||
        !metadata.description.trim() ||
        metadata.description.length > 1024
      )
        validation = "Add a description that explains when to use this skill.";
    }
  } catch {
    validation = "Fix the YAML frontmatter syntax before publishing.";
  }
  const update = (content: string) =>
    setFiles(files.map((f) => (f.path === file.path ? { ...f, content } : f)));
  const save = async (publish = false) => {
    setBusy(true);
    setError("");
    try {
      let saved = current;
      if (!saved) {
        saved = await api<Skill>("/skills", "POST", {
          title: title || metadata.name,
          name: metadata.name,
          description: metadata.description,
          files,
        });
        setCurrent(saved);
      } else {
        saved = await api<Skill>(`/skills/${saved.id}`, "PATCH", {
          title: title || metadata.name,
          description: metadata.description,
          draft: files,
        });
        setCurrent(saved);
      }
      if (publish) {
        await api(`/skills/${saved.id}/publish`, "POST", {
          files,
          message: message || "Published custom skill",
        });
        await onPublished();
      } else await onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const assist = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ files: SkillFile[] }>(
        "/skills/assist",
        "POST",
        { title: title || "Workflow helper", workflow },
      );
      setFiles(result.files);
      setActive("SKILL.md");
      setMode("scratch");
      setPreview(true);
      setAssistedDraft(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const importSource = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api<Skill | { pending: true }>(
        "/skills/import",
        "POST",
        { source, name: sourceName || undefined },
      );
      if ("pending" in result) {
        await onQueued();
        return;
      }
      setCurrent(result);
      setTitle(result.title);
      setFiles(result.draft || result.files);
      setMode("scratch");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const importFolder = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    setError("");
    try {
      const result: SkillFile[] = await Promise.all(
        Array.from(list).map(async (f) => {
          const relative = (f.webkitRelativePath || f.name)
            .split("/")
            .slice(f.webkitRelativePath ? 1 : 0)
            .join("/");
          const binary =
            !/\.(md|txt|json|ya?ml|ts|js|py|sh|toml|csv|xml|html|css|svg|rs|go)$/.test(
              f.name,
            );
          let content: string;
          if (binary) {
            const bytes = new Uint8Array(await f.arrayBuffer());
            let s = "";
            for (const byte of bytes) s += String.fromCharCode(byte);
            content = btoa(s);
          } else content = await f.text();
          return {
            path: relative,
            content,
            encoding: binary ? "base64" : undefined,
            mode: /\.(sh|py)$/.test(f.name) ? 0o755 : 0o644,
          };
        }),
      );
      setFiles(result);
      setActive("SKILL.md");
      setMode("scratch");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const uploadAssets = async (list: FileList | null) => {
    if (!list?.length) return;
    setError("");
    const additions: SkillFile[] = [];
    for (const asset of Array.from(list)) {
      const path = `assets/${asset.name}`;
      if (files.some((f) => f.path === path)) {
        setError(`${path} already exists. Remove it before replacing it.`);
        return;
      }
      const bytes = new Uint8Array(await asset.arrayBuffer());
      let raw = "";
      for (const b of bytes) raw += String.fromCharCode(b);
      additions.push({
        path,
        content: btoa(raw),
        encoding: "base64",
        mode: 0o644,
      });
    }
    setFiles([...files, ...additions]);
    setActive(additions[0].path);
  };
  return (
    <div className="page editor-page">
      <button className="text-link back-link" onClick={onCancel}>
        <ArrowLeft size={15} />
        Back to your library
      </button>
      <div className="page-heading">
        <div>
          <h1>
            {current ? "Edit your skill" : "Make it your own"}
            <span className="heading-dot">.</span>
          </h1>
          <p>Your workflow, written once. Every agent can use it.</p>
        </div>
        <div className="heading-actions">
          <span className="custom-tag">Draft</span>
          <button className="button" disabled={busy} onClick={() => save()}>
            <Save size={15} />
            Save draft
          </button>
          <button
            className="button primary"
            disabled={busy || !!validation}
            onClick={() => save(true)}
          >
            {busy ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <ArrowUpRight size={15} />
            )}
            Publish skill
          </button>
        </div>
      </div>
      {!current && (
        <div className="creation-methods">
          {[
            { id: "scratch", icon: FileText, label: "Start from scratch" },
            { id: "assist", icon: Sparkles, label: "Describe a workflow" },
            { id: "import", icon: Upload, label: "Import an existing skill" },
          ].map(({ id, icon: Icon, label }) => (
            <button
              className={mode === id ? "active" : ""}
              onClick={() => setMode(id)}
              key={id}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <div className="notice error" role="alert">
          <AlertTriangle size={16} />
          {error}
        </div>
      )}
      <label className="field editor-title-field">
        Skill title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Pull request reviewer"
        />
      </label>
      {mode === "assist" ? (
        <section className="assisted-editor">
          <FileText size={27} />
          <h2>What should your agent know how to do?</h2>
          <p>
            Describe the inputs, the steps, and what a good result looks like.
            Equip turns those details into a structured starting template. You
            review every instruction before publishing.
          </p>
          <label className="field">
            Your workflow
            <textarea
              value={workflow}
              onChange={(e) => setWorkflow(e.target.value)}
              rows={8}
              placeholder="When reviewing a pull request, read the changed files, check for security and accessibility issues, run the relevant tests, and leave concise, actionable feedback…"
            />
          </label>
          <div className="assisted-footer">
            <span>A structured template. Review before publishing.</span>
            <button
              className="button primary"
              disabled={busy || !workflow.trim()}
              onClick={assist}
            >
              {busy ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <FileText size={16} />
              )}
              Build starting draft
            </button>
          </div>
        </section>
      ) : mode === "import" ? (
        <section className="import-editor">
          <Upload size={28} />
          <h2>Your existing expertise belongs here.</h2>
          <p>
            Import the complete folder, including scripts, references, and
            assets.
          </p>
          <label className="field">
            Repository or skill source
            <input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="github.com/your-team/skills"
            />
          </label>
          <label className="field">
            Skill name{" "}
            <span className="field-hint">
              Optional for a source containing one skill
            </span>
            <input
              value={sourceName}
              onChange={(e) => setSourceName(e.target.value)}
              placeholder="my-skill"
            />
          </label>
          <button
            className="button primary"
            disabled={busy || !source.trim()}
            onClick={importSource}
          >
            {busy ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <Github size={16} />
            )}
            Import source
          </button>
          <div className="or-divider">or</div>
          <button
            className="folder-upload"
            onClick={() => input.current?.click()}
          >
            <Folder size={27} />
            <strong>Choose a skill folder</strong>
            <span>SKILL.md, scripts, references, and assets</span>
          </button>
          <input
            ref={input}
            type="file"
            multiple
            {...({ webkitdirectory: "", directory: "" } as any)}
            hidden
            onChange={(e) => importFolder(e.target.files)}
          />
        </section>
      ) : (
        <>
          {assistedDraft ? (
            <div className="notice assisted-review" role="status">
              <Check size={16} />
              <span>
                Your starting draft is ready. Read the preview, then switch to
                Edit to change the instructions before publishing.
              </span>
              <button onClick={() => setPreview(false)}>Edit draft</button>
            </div>
          ) : null}
          <div className="editor-workbench">
            <aside className="editor-file-tree">
              <div className="editor-file-tree-head">
                <span>SKILL FILES</span>
                <span>{files.length}</span>
              </div>
              {files.map((f) => (
                <button
                  className={active === f.path ? "active" : ""}
                  onClick={() => setActive(f.path)}
                  key={f.path}
                >
                  {f.path.includes("/") ? (
                    <Folder size={14} />
                  ) : (
                    <FileText size={14} />
                  )}
                  <span>{f.path}</span>
                </button>
              ))}
              <form
                className="add-file"
                onSubmit={(e) => {
                  e.preventDefault();
                  const p = newFile.trim();
                  if (
                    !p ||
                    files.some((f) => f.path === p) ||
                    p.startsWith("/") ||
                    p.split(/[\\/]/).includes("..")
                  )
                    return;
                  setFiles([
                    ...files,
                    {
                      path: p,
                      content: "",
                      mode: p.endsWith(".sh") ? 0o755 : 0o644,
                    },
                  ]);
                  setActive(p);
                  setNewFile("");
                }}
              >
                <input
                  aria-label="New file path"
                  placeholder="references/guide.md"
                  value={newFile}
                  onChange={(e) => setNewFile(e.target.value)}
                />
                <button aria-label="Add file" disabled={!newFile}>
                  <Plus size={15} />
                </button>
              </form>
              <button
                className="asset-upload"
                onClick={() => assets.current?.click()}
              >
                <Upload size={14} />
                Add assets
              </button>
              <input
                ref={assets}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  uploadAssets(e.target.files);
                  e.target.value = "";
                }}
              />
              <div className="file-tree-tip">
                <Folder size={17} />
                <p>
                  Bundle scripts, reference documents, and assets. The whole
                  folder travels with your skill.
                </p>
              </div>
            </aside>
            <div className="editor-document">
              <div className="editor-document-head">
                <span>
                  <FileText size={14} />
                  {file.path}
                </span>
                <div className="editor-file-actions">
                  {file.path !== "SKILL.md" && (
                    <>
                      <label className="executable-toggle">
                        <input
                          type="checkbox"
                          checked={!!((file.mode || 0) & 0o111)}
                          onChange={(e) =>
                            setFiles(
                              files.map((f) =>
                                f.path === file.path
                                  ? {
                                      ...f,
                                      mode: e.target.checked ? 0o755 : 0o644,
                                    }
                                  : f,
                              ),
                            )
                          }
                        />
                        Executable
                      </label>
                      <button
                        className="icon-button danger"
                        aria-label={`Delete ${file.path}`}
                        onClick={() => {
                          setFiles(files.filter((f) => f.path !== file.path));
                          setActive("SKILL.md");
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                  <div className="segmented small">
                    <button
                      className={!preview ? "active" : ""}
                      onClick={() => setPreview(false)}
                    >
                      <Code2 size={14} />
                      Edit
                    </button>
                    <button
                      className={preview ? "active" : ""}
                      onClick={() => setPreview(true)}
                    >
                      <Eye size={14} />
                      Preview
                    </button>
                  </div>
                </div>
              </div>
              {file.encoding === "base64" ? (
                <div className="empty">
                  <Folder size={27} />
                  <p>
                    Binary asset ·{" "}
                    {Math.round((file.content.length * 0.75) / 1024)} KB
                  </p>
                </div>
              ) : preview && !file.path.endsWith(".md") ? (
                <pre className="file-preview editor-preview">
                  {file.content}
                </pre>
              ) : preview ? (
                <div className="markdown editor-preview">
                  <Markdown remarkPlugins={[remarkGfm]}>
                    {file.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")}
                  </Markdown>
                </div>
              ) : (
                <textarea
                  className="code-editor"
                  aria-label={`Edit ${file.path}`}
                  value={file.content}
                  onChange={(e) => update(e.target.value)}
                  spellCheck={false}
                />
              )}
              <div className="editor-validation">
                {validation ? (
                  <>
                    <AlertTriangle size={14} />
                    <span>{validation}</span>
                  </>
                ) : (
                  <>
                    <Check size={14} />
                    <span>Valid Agent Skill</span>
                  </>
                )}
                <span>
                  {file.encoding === "base64"
                    ? "Binary asset"
                    : "Markdown & plain text"}
                </span>
              </div>
            </div>
          </div>
          <div className="publish-note">
            <div>
              <strong>Drafts stay here. Published versions travel.</strong>
              <p>
                Your computers receive changes only when you publish. You can
                roll back to any published version.
              </p>
            </div>
            <label className="field">
              Version note
              <input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What changed in this version?"
              />
            </label>
          </div>
        </>
      )}
    </div>
  );
}

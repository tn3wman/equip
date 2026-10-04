import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type FormEvent,
} from "react";
import {
  ArrowUpRight,
  ArrowRight,
  Plus,
  Search,
  ChevronDown,
  ChevronRight,
  Check,
  Copy,
  Command,
  BookOpen,
  Compass,
  Laptop,
  Activity as ActivityIcon,
  Settings2,
  HelpCircle,
  MoreHorizontal,
  RefreshCw,
  Terminal,
  X,
  ArrowDownToLine,
  Box,
  CircleHelp,
  Menu,
  LogOut,
  Circle,
  SlidersHorizontal,
  Sparkles,
  GitFork as Github,
  WifiOff,
  AlertTriangle,
  Monitor,
  ExternalLink,
  Bell,
  ChevronsUpDown,
  Layers,
  Loader2,
  FileText,
} from "lucide-react";
import { api } from "./api";
import {
  Logo,
  SkillIcon,
  Status,
  OsIcon,
  ago,
  revision,
  Dialog,
  Empty,
  navigateTabs,
} from "./components";
import type {
  Skill,
  Device,
  Workspace,
  SyncStatus,
  SkillFile,
  Receipt,
  DiscoveryResult,
  DiscoveryView,
} from "../shared/types";
import { SafetyBadge } from "./Safety";
import SkillConflict from "./SkillConflict";
import { reviewedFilesRevision } from "../shared/conflicts";
import { instructionsAsSkill } from "../shared/instructions";
const lazyReloadKey = "equip:stale-chunk-reload";
function lazyWithReload<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    try {
      const module = await load();
      sessionStorage.removeItem(lazyReloadKey);
      return module;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const staleChunk =
        /dynamically imported module|loading chunk|chunkloaderror/i.test(message);
      if (staleChunk && !sessionStorage.getItem(lazyReloadKey)) {
        sessionStorage.setItem(lazyReloadKey, "1");
        location.reload();
        return new Promise<never>(() => undefined);
      }
      throw error;
    }
  });
}
const SkillDetail = lazyWithReload(() => import("./SkillDetail"));
const Editor = lazyWithReload(() => import("./Editor"));
const InstructionsPage = lazyWithReload(() => import("./Instructions"));
import { conflictDevices, deployment, deviceStatus } from "./sync-state";

const pages = [
  "library",
  "instructions",
  "discover",
  "devices",
  "activity",
  "settings",
] as const;
type Page = (typeof pages)[number] | "editor";
export default function App() {
  const [page, setPage] = useState<Page>(
    () => (location.hash.slice(1) as Page) || "library",
  );
  const [workspace, setWorkspace] = useState<Workspace>();
  const [emailSignIn, setEmailSignIn] = useState<boolean | null>(null);
  const [authLinkError, setAuthLinkError] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Skill>();
  const [edit, setEdit] = useState<Skill>();
  const [connect, setConnect] = useState(false);
  const [auth, setAuth] = useState(false);
  const [help, setHelp] = useState(false);
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState(
    new URLSearchParams(location.search).get("code") || "",
  );
  const bootstrap = useRef<Promise<void> | null>(null);
  const authConfigResolved = useRef(false);
  useEffect(() => {
    if (!menu) return;
    const previous = document.activeElement as HTMLElement;
    const focusable = () =>
      [
        ...document.querySelectorAll<HTMLElement>(
          ".sidebar button, .sidebar a[href], .mobile-scrim",
        ),
      ].filter(
        (element) =>
          element.getClientRects().length > 0 && !element.closest("[inert]"),
      );
    focusable()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      if (event.key === "Escape") setMenu(false);
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      requestAnimationFrame(() => previous?.focus());
    };
  }, [menu]);
  const refresh = useCallback(async () => {
    try {
      setWorkspace(await api<Workspace>("/workspace?view=dashboard"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  const loadAuthConfig = useCallback(async () => {
    try {
      const result = await api<{ emailSignIn: boolean }>("/auth/config");
      authConfigResolved.current = true;
      setEmailSignIn(result.emailSignIn);
    } catch {
      // Keep the capability unknown so a transient deployment error cannot
      // expose the unsupported password form on a hosted installation.
    }
  }, []);
  useEffect(() => {
    if (!bootstrap.current) {
      const search = new URLSearchParams(location.search);
      const token = search.get("token");

      if (token) {
        search.delete("token");
        const cleanUrl = `${location.pathname}${search.size ? `?${search}` : ""}${location.hash}`;
        history.replaceState(null, "", cleanUrl);
      }

      const config = loadAuthConfig();
      const load = token
        ? api<Workspace>("/auth/email/consume", "POST", { token })
            .then((result) => {
              setWorkspace(result);
              setError("");
            })
            .catch(async () => {
              setAuthLinkError(
                "That sign-in link is invalid or has expired. Request a fresh link below.",
              );
              setAuth(true);
              await refresh();
            })
        : refresh();

      bootstrap.current = Promise.all([config, load]).then(() => undefined);
    }

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    void bootstrap.current.then(() => {
      if (!cancelled)
        timer = setInterval(() => {
          void refresh();
          if (!authConfigResolved.current) void loadAuthConfig();
        }, 5000);
    });
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [loadAuthConfig, refresh]);
  useEffect(() => {
    if (auth && emailSignIn === null) void loadAuthConfig();
  }, [auth, emailSignIn, loadAuthConfig]);
  useEffect(() => {
    const hash = () => {
      const p = location.hash.slice(1) as Page;
      if ([...pages, "editor"].includes(p)) {
        setPage(p);
        setSelected(undefined);
      }
    };
    window.addEventListener("hashchange", hash);
    return () => window.removeEventListener("hashchange", hash);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  const navigate = (p: Page) => {
    setSelected(undefined);
    setPage(p);
    location.hash = p;
    setMenu(false);
  };
  const notify = (message: string) => setToast(message);
  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
      notify(message);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        document.getElementById("skill-search")?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  if (!workspace)
    return (
      <div className="startup">
        <Logo />
        <h1>Equip</h1>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button className="button primary" onClick={refresh}>
              Try again
            </button>
          </>
        ) : (
          <>
            <Loader2 className="spin" size={20} />
            <p>Opening your workspace…</p>
          </>
        )}
      </div>
    );
  const activeDevices = workspace.devices.filter((d) => !d.disconnectedAt);
  const selectedSkills = workspace.skills.filter((s) => s.selected);
  const pending = activeDevices.filter((d) => !d.online).length;
  const startEditor = async (skill?: Skill) => {
    try {
      const complete = skill && workspace.skills.some(s => s.id === skill.id) && !skill.files.length && !skill.draft ? await api<Skill>(`/skills/${skill.id}`) : skill;
      setEdit(complete);
      setSelected(undefined);
      navigate("editor");
    } catch (error) { notify((error as Error).message); }
  };
  return (
    <div className="app">
      <a className="skip-link" href="#main-content" inert={menu}>
        Skip to content
      </a>
      <aside
        id="workspace-navigation"
        inert={!!(selected || auth || connect || help || approval)}
        className={`sidebar ${menu ? "open" : ""}`}
      >
        <a
          className="brand"
          href="#library"
          onClick={() => navigate("library")}
        >
          <Logo />
          <span>
            equip<span className="brand-period">.</span>
          </span>
        </a>
        <button className="workspace-picker" onClick={() => setAuth(true)}>
          <span className="workspace-avatar">
            {workspace.name.charAt(0).toUpperCase()}
          </span>
          <span>
            <strong>{workspace.name}</strong>
            <small>Personal workspace</small>
          </span>
          <ChevronsUpDown size={14} />
        </button>
        <nav aria-label="Main navigation">
          <div className="nav-section">Workspace</div>
          {[
            { id: "library", label: "Skill library", icon: BookOpen },
            { id: "instructions", label: "Instructions", icon: FileText },
            { id: "discover", label: "Discover", icon: Compass },
            { id: "devices", label: "Computers", icon: Laptop },
            { id: "activity", label: "Activity", icon: ActivityIcon },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "active" : ""}`}
              onClick={() => navigate(id as Page)}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === "library" ? (
                <span className="nav-count">{selectedSkills.length}</span>
              ) : id === "instructions" ? (
                <span className="nav-count">{workspace.instructions?.filter((item) => item.selected).length ?? 0}</span>
              ) : id === "devices" ? (
                <span className="nav-dot" />
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-connect">
          <div className="sidebar-connect-icon">
            <Terminal size={21} />
            <Plus size={13} />
          </div>
          <h3>Your setup, everywhere.</h3>
          <p>Bring your skills to another computer in one command.</p>
          <button onClick={() => setConnect(true)}>
            Connect a computer <ArrowUpRight size={15} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            onClick={() => navigate("settings")}
          >
            <Settings2 size={18} />
            <span>Settings</span>
          </button>
          <button className="nav-item" onClick={() => setHelp(true)}>
            <CircleHelp size={18} />
            <span>Help & getting started</span>
            <ArrowUpRight size={14} />
          </button>
          <button className="profile" onClick={() => setAuth(true)}>
            <span className="user-avatar">
              {workspace.name
                .split(" ")
                .map((s) => s[0])
                .slice(0, 2)
                .join("")}
            </span>
            <span>
              <strong>{workspace.name}</strong>
              <small>
                {workspace.demo ? "Demo workspace" : "Personal account"}
              </small>
            </span>
            <MoreHorizontal size={18} />
          </button>
        </div>
      </aside>
      {menu && (
        <button
          className="mobile-scrim"
          onClick={() => setMenu(false)}
          aria-label="Close navigation"
        />
      )}
      <div
        className="main-shell"
        inert={!!(menu || selected || auth || connect || help || approval)}
      >
        <header className="topbar">
          <div>
            <button
              className="icon-button mobile-menu"
              onClick={() => setMenu(!menu)}
              aria-label="Open navigation"
              aria-expanded={menu}
              aria-controls="workspace-navigation"
            >
              <Menu size={21} />
            </button>
            <span className="breadcrumb-root">Workspace</span>
            <ChevronRight size={13} />
            <span>
              {page === "editor"
                ? "Skill editor"
                : page === "library"
                  ? "Skill library"
                  : page === "instructions"
                    ? "Instructions"
                  : page === "devices"
                    ? "Computers"
                    : page.charAt(0).toUpperCase() + page.slice(1)}
            </span>
          </div>
          <div className="topbar-right">
            <span className="system-status">
              <span />
              {workspace.demo
                ? "Demo workspace"
                : activeDevices.some((d) => d.online && !d.disconnect)
                  ? "Devices connected"
                  : "No computers online"}
            </span>
            <span className="topbar-divider" />
            <button
              className="icon-button"
              aria-label="View activity"
              onClick={() => navigate("activity")}
            >
              <Bell size={17} />
            </button>
            <button
              className="tiny-avatar"
              onClick={() => setAuth(true)}
              aria-label="Open account"
            >
              {workspace.name[0]}
            </button>
          </div>
        </header>
        <main id="main-content">
          {error && (
            <div className="notice error" role="alert">
              <AlertTriangle size={16} />
              {error}
              <button onClick={refresh}>Retry</button>
            </div>
          )}
          {page === "library" && (
            <Library
              workspace={workspace}
              open={setSelected}
              navigate={navigate}
              create={() => startEditor()}
              connect={() => setConnect(true)}
              run={run}
            />
          )}
          {page === "instructions" && (
            <Suspense fallback={<div className="catalog-loading"><Loader2 className="spin" size={20} />Opening instructions…</div>}>
              <InstructionsPage workspace={workspace} refresh={refresh} notify={notify} />
            </Suspense>
          )}
          {page === "discover" && (
            <Discover
              workspace={workspace}
              open={setSelected}
              notify={notify}
            />
          )}
          {page === "devices" && (
            <Devices
              workspace={workspace}
              connect={() => setConnect(true)}
              run={run}
            />
          )}
          {page === "activity" && <Activity workspace={workspace} />}
          {page === "settings" && (
            <Settings
              workspace={workspace}
              auth={() => setAuth(true)}
              run={run}
            />
          )}
          {page === "editor" && (
            <Suspense
              fallback={
                <div className="catalog-loading">
                  <Loader2 className="spin" size={20} />
                  Opening the editor…
                </div>
              }
            >
              <Editor
                skill={edit}
                onSaved={async (skill) => {
                  await refresh();
                  setEdit(skill);
                  notify("Draft saved. Your published version is unchanged.");
                }}
                onPublished={async () => {
                  await refresh();
                  navigate("library");
                  notify(
                    "Skill published. Connected computers will receive this revision.",
                  );
                }}
                onQueued={async () => {
                  await refresh();
                  navigate("library");
                  notify(
                    "Source queued. A connected computer will import it with its existing repository access.",
                  );
                }}
                onCancel={() => navigate("library")}
              />
            </Suspense>
          )}
        </main>
        <footer className="main-footer">
          <span>
            <Logo small />
            Your agents, equipped.
          </span>
          <span>
            {workspace.demo ? (
              <>
                <span className="demo-dot" />
                Demo workspace · Sample devices
              </>
            ) : (
              "Installations confirmed by computer receipts."
            )}
            <button onClick={() => setHelp(true)}>
              Built on Vercel Skills <ArrowUpRight size={12} />
            </button>
          </span>
        </footer>
      </div>
      {selected && (
        <Suspense
          fallback={
            <div className="detail-panel">
              <div className="catalog-loading">
                <Loader2 className="spin" size={20} />
                Loading skill…
              </div>
            </div>
          }
        >
          <SkillDetail
            skill={
              workspace.skills.find((s) => s.id === selected.id) || selected
            }
            workspace={workspace}
            onClose={() => setSelected(undefined)}
            onEdit={startEditor}
            onChange={async () => {
              await refresh();
            }}
            notify={notify}
          />
        </Suspense>
      )}
      {connect && (
        <ConnectDialog
          onClose={() => setConnect(false)}
          devices={activeDevices}
          skills={workspace.skills}
          generation={workspace.generation}
        />
      )}
      {auth && (
        <AuthDialog
          workspace={workspace}
          emailSignIn={emailSignIn}
          initialError={authLinkError}
          retryConfig={loadAuthConfig}
          onClose={() => setAuth(false)}
          onSuccess={async (message) => {
            await refresh();
            setAuth(false);
            setAuthLinkError("");
            notify(message);
          }}
        />
      )}
      {help && (
        <Dialog title="Your agents, equipped." onClose={() => setHelp(false)}>
          <div className="dialog-body help">
            <p>
              Choose your skills once. Equip keeps the same published revision
              on every connected computer and detected agent.
            </p>
            <ol>
              <li>
                <strong>Build your library.</strong> Discover a community skill
                or create your own. Inspect its instructions before selecting
                it.
              </li>
              <li>
                <strong>Connect a computer.</strong> Run the installation
                command, then approve it in your browser. Your agent credentials
                stay on that computer.
              </li>
              <li>
                <strong>Make a change.</strong> Publish, update, or remove a
                skill. Computers report back after applying it.
              </li>
            </ol>
            <p>
              Offline computers catch up when they reconnect. Local edits stop
              an update until you decide how to handle them. Cloud agent
              accounts require their own supported integrations.
            </p>
            <a
              className="text-link"
              href="https://skills.sh/docs"
              target="_blank"
              rel="noreferrer"
            >
              Explore the Agent Skills ecosystem <ExternalLink size={14} />
            </a>
            <button
              className="button primary"
              onClick={() => {
                setHelp(false);
                setConnect(true);
              }}
            >
              Connect a computer <ArrowRight size={16} />
            </button>
          </div>
        </Dialog>
      )}
      {approval && !auth && (
        <Approval
          code={approval}
          demo={workspace.demo}
          auth={() => setAuth(true)}
          onClose={() => {
            setApproval("");
            history.replaceState(null, "", "/");
          }}
          refresh={refresh}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          <span>{toast}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function Library({
  workspace,
  open,
  navigate,
  create,
  connect,
  run,
}: {
  workspace: Workspace;
  open: (s: Skill) => void;
  navigate: (p: Page) => void;
  create: () => void;
  connect: () => void;
  run: (fn: () => Promise<unknown>, message: string) => Promise<void>;
}) {
  const [tab, setTab] = useState("all");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const skills = workspace.skills.filter((s) => s.selected);
  const updates = skills.filter(
    (s) => s.upstreamCheckedAt && s.upstreamRevision && s.upstreamRevision !== s.revision,
  ).length;
  const visible = skills.filter(
    (s) =>
      (tab === "all" || s.kind === tab) &&
      (filter === "all" ||
        (filter === "updates"
          ? s.upstreamCheckedAt && s.upstreamRevision && s.upstreamRevision !== s.revision
          : filter === "disabled"
            ? !s.enabled
            : s.enabled)) &&
      `${s.title} ${s.description} ${s.author}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const devices = workspace.devices.filter((d) => !d.disconnectedAt);
  const offline = devices.filter((d) => !d.online && !d.disconnect);
  return (
    <div className="page library-page">
      <div className="page-heading">
        <div>
          <h1>
            Skill library<span className="heading-dot">.</span>
          </h1>
          <p>A little more capable. On every computer.</p>
        </div>
        <div className="heading-actions">
          <button className="button" onClick={create}>
            <Plus size={16} />
            Create a skill
          </button>
          <button
            className="button primary"
            onClick={() => navigate("discover")}
          >
            <Compass size={16} />
            Discover skills
            <ArrowUpRight size={14} />
          </button>
        </div>
      </div>
      <div className="workspace-summary">
        <span>
          <Layers size={15} />
          <strong>{skills.length}</strong> skills in your toolkit
        </span>
        <span>
          <Laptop size={15} />
          <strong>{devices.length}</strong> connected{" "}
          {devices.length === 1 ? "computer" : "computers"}
        </span>
        {updates > 0 && (
          <button
            onClick={() => setFilter(filter === "updates" ? "all" : "updates")}
          >
            <RefreshCw size={14} />
            {updates} updates available
            <ArrowRight size={13} />
          </button>
        )}
      </div>
      {workspace.sourceRequests?.length ? (
        <div className="notice">
          <ClockIcon />
          <span>
            {workspace.sourceRequests.length} source{" "}
            {workspace.sourceRequests.length === 1
              ? "request is"
              : "requests are"}{" "}
            waiting for a connected computer with access. Credentials stay on
            the computer.
          </span>
          <button onClick={() => navigate("activity")}>View activity</button>
        </div>
      ) : null}
      <div className="library-layout">
        <section className="library-main" aria-label="Your skill collection">
          <div className="library-controls">
            <div
              className="tabs"
              role="tablist"
              onKeyDown={navigateTabs}
              aria-label="Skill type"
            >
              {[
                { id: "all", name: "All skills" },
                { id: "third-party", name: "Community" },
                { id: "custom", name: "Custom" },
              ].map((t) => (
                <button
                  role="tab"
                  tabIndex={tab === t.id ? 0 : -1}
                  aria-selected={tab === t.id}
                  key={t.id}
                  className={tab === t.id ? "active" : ""}
                  onClick={() => setTab(t.id)}
                >
                  {t.name}
                  <span>
                    {
                      skills.filter((s) => t.id === "all" || s.kind === t.id)
                        .length
                    }
                  </span>
                </button>
              ))}
            </div>
            <div className="collection-tools">
              <label className="search-box">
                <Search size={16} />
                <input
                  id="skill-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search your skills"
                  aria-label="Search your skills"
                />
                <kbd>⌘ K</kbd>
              </label>
              <label className="filter-select">
                <SlidersHorizontal size={15} />
                <select
                  aria-label="Filter skills"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">Filter</option>
                  <option value="updates">Updates available</option>
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>
            </div>
          </div>
          <div className="skill-table">
            <div className="table-head">
              <span>SKILL</span>
              <span>REVISION</span>
              <span>STATUS</span>
              <span />
            </div>
            {visible.map((skill) => {
              const state = deployment(skill, devices);
              const status = state.status;
              const needsReview = status === "conflicted" ? conflictDevices(skill, devices) : [];
              return (
                <button
                  className={`skill-row ${!skill.enabled ? "is-disabled" : ""}`}
                  key={skill.id}
                  onClick={() => open(skill)}
                >
                  <div className="skill-cell">
                    <SkillIcon skill={skill} />
                    <div>
                      <div className="skill-title">
                        {skill.title}
                        {skill.kind === "custom" && (
                          <span className="custom-tag">Custom</span>
                        )}
                      </div>
                      <p>{skill.description}</p>
                      <span className="skill-source">
                        {skill.kind === "custom" ? (
                          <>
                            <span className="source-dot" />
                            Your workspace
                          </>
                        ) : (
                          <>
                            <Github size={11} />
                            {skill.source}
                          </>
                        )}
                      </span>
                    </div>
                  </div>
                  <div className="revision-cell">
                    <code>{revision(skill.revision)}</code>
                    {skill.upstreamCheckedAt && skill.upstreamRevision &&
                    skill.upstreamRevision !== skill.revision ? (
                      <span className="update-label">Update available</span>
                    ) : (
                      <span>
                        {skill.kind === "custom"
                          ? "On publish"
                          : skill.autoUpdate
                            ? "Automatic updates"
                            : "Manual updates"}
                      </span>
                    )}
                  </div>
                  <div className="status-cell">
                    <Status
                      status={
                        !skill.enabled
                          ? "disabled"
                          : !skill.versions.length
                            ? "draft"
                            : status
                      }
                    />
                    <small>
                      {!skill.enabled
                        ? "Not installed"
                        : !skill.versions.length
                          ? "Unpublished"
                          : `${state.complete} of ${state.total} computers`}
                    </small>
                    {!!needsReview.length && <small className="conflict-origin">{needsReview.length === 1 ? `${needsReview[0].name} needs review` : `${needsReview.length} computers need review`}</small>}
                  </div>
                  <MoreHorizontal className="row-more" size={18} />
                </button>
              );
            })}
            {!visible.length && (
              <Empty
                title={
                  skills.length
                    ? "No matching skills"
                    : "Your toolkit starts here"
                }
                description={
                  skills.length
                    ? "Try a different search or clear your filters."
                    : "Discover a skill or write your own. Equip will handle the installation."
                }
              >
                <button
                  className="button primary"
                  onClick={
                    skills.length
                      ? () => {
                          setQuery("");
                          setFilter("all");
                          setTab("all");
                        }
                      : () => navigate("discover")
                  }
                >
                  {skills.length ? "Clear filters" : "Discover skills"}
                </button>
              </Empty>
            )}
          </div>
          <div className="collection-footer">
            <span>
              {visible.length} {visible.length === 1 ? "skill" : "skills"}
              {filter !== "all" ? " · Filtered" : ""}
            </span>
            <span>
              <Check size={13} />
              Selected revisions stay consistent across computers
            </span>
          </div>
          <div className="connect-banner">
            <div className="terminal-art">
              <Terminal size={23} />
              <span className="terminal-art-dot" />
            </div>
            <div>
              <h3>A new computer. The same toolkit.</h3>
              <p>
                One command connects your agents and brings your skills along.
              </p>
            </div>
            <button onClick={connect}>
              Connect a computer <ArrowUpRight size={15} />
            </button>
          </div>
        </section>
        <aside className="fleet-panel">
          <div className="section-title">
            <h2>Your computers</h2>
            <button
              className="icon-button"
              onClick={connect}
              aria-label="Connect a computer"
            >
              <Plus size={17} />
            </button>
          </div>
          <div className="fleet-list">
            {devices.slice(0, 4).map((device) => (
              <button
                key={device.id}
                className="fleet-device"
                onClick={() => navigate("devices")}
              >
                <span
                  className={`device-icon ${!device.online ? "muted" : ""}`}
                >
                  <OsIcon device={device} />
                </span>
                <span className="fleet-device-info">
                  <strong>{device.name}</strong>
                  <small>
                    {device.agents.reduce((count, agent) => count + (agent.aliases?.length || 1), 0)} configurations ·{" "}
                    {device.disconnect
                      ? "Disconnection pending"
                      : device.online
                      ? deviceStatus(
                          device,
                          workspace.skills,
                          workspace.generation,
                          workspace.instructions,
                        ) === "synchronized"
                        ? "Synced " + ago(device.lastSync)
                        : "Sync pending"
                      : "Last seen " + ago(device.lastSeen)}
                  </small>
                </span>
                <span
                  className={`online-dot ${device.online && !device.disconnect ? "on" : "off"}`}
                  aria-label={
                    device.disconnect
                      ? "Disconnection pending"
                      : device.online
                        ? "Online"
                        : "Offline"
                  }
                />
              </button>
            ))}
            {!devices.length && (
              <div className="fleet-empty">
                <Laptop size={26} />
                <p>Connect your first computer to put your skills to work.</p>
                <button className="text-link" onClick={connect}>
                  Get connected <ArrowRight size={14} />
                </button>
              </div>
            )}
          </div>
          {offline.length > 0 && (
            <div className="offline-note">
              <WifiOff size={14} />
              <p>
                <strong>{offline[0].name} is offline.</strong> It will catch up
                automatically when it reconnects.
              </p>
            </div>
          )}
          <button
            className="text-link fleet-link"
            onClick={() => navigate("devices")}
          >
            Manage computers
            <ArrowRight size={14} />
          </button>
          <div className="activity-preview">
            <div className="section-title">
              <h2>Latest activity</h2>
              <ActivityIcon size={15} />
            </div>
            {workspace.activity.slice(0, 3).map((a) => (
              <div className="activity-item" key={a.id}>
                <span className={`activity-mark ${a.status}`}>
                  <Check size={11} />
                </span>
                <div>
                  <p>{a.title}</p>
                  <span>{ago(a.timestamp)}</span>
                </div>
              </div>
            ))}
            {!workspace.activity.length && (
              <p className="muted-copy">
                Your updates and sync receipts will appear here.
              </p>
            )}
            <button className="text-link" onClick={() => navigate("activity")}>
              View all activity
              <ArrowRight size={14} />
            </button>
          </div>
          <div className="quiet-promise">
            <Box size={23} strokeWidth={1.3} />
            <p>
              Configure once.
              <br />
              Stay equipped everywhere.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Discover({
  workspace,
  open,
  notify,
}: {
  workspace: Workspace;
  open: (s: Skill) => void;
  notify: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<DiscoveryView>("all-time");
  const [catalog, setCatalog] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);
  const [source, setSource] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [importing, setImporting] = useState(false);
  const [sourceInspecting, setSourceInspecting] = useState(false);
  const [sourceQueueing, setSourceQueueing] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [page, setCatalogPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const requestId = useRef(0);
  const search = query.trim().length >= 2 ? query.trim() : "";
  useEffect(() => {
    const id = ++requestId.current;
    const controller = setTimeout(() => {
      setLoading(true);
      api<DiscoveryResult>(
        `/discover?q=${encodeURIComponent(search)}&view=${view}&page=${page}`,
      )
        .then((data) => {
          if (id === requestId.current) {
            setCatalog((current) => page ? [...current, ...data.skills] : data.skills);
            setLive(data.live);
            setLoadError(data.error || "");
            setHasMore(Boolean(data.pagination?.hasMore));
          }
        })
        .catch((e) => {
          if (id === requestId.current) setLoadError(e.message);
        })
        .finally(() => {
          if (id === requestId.current) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(controller);
    };
  }, [search, view, page]);
  useEffect(() => { setCatalogPage(0); setCatalog([]); }, [search, view]);
  const sourceKey = (skill: Pick<Skill, "source" | "name">) => {
    let source = skill.source.trim().toLowerCase().replace(/\.git$/, "").replace(/^git\+/, "");
    source = source.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/^git@github\.com:/, "");
    source = source.split("@")[0].replace(/^\/+|\/+$/g, "");
    return `${source}:${skill.name.trim().toLowerCase()}`;
  };
  const installed = new Map(workspace.skills.filter((skill) => skill.selected).map((skill) => [sourceKey(skill), skill]));
  const openResolved = (skill: Skill) => open(installed.get(sourceKey(skill)) || skill);
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>
            Discover skills<span className="heading-dot">.</span>
          </h1>
          <p>Good instructions make great agents. Find your next advantage.</p>
        </div>
        <button className="button" onClick={() => setImporting(true)}>
          <Github size={16} />
          Add from a source
          <Plus size={15} />
        </button>
      </div>
      <div className="discovery-feature">
        <div>
          <span className="feature-label">
            <Compass size={14} />
            THE OPEN SKILLS ECOSYSTEM
          </span>
          <h2>Borrow a little expertise.</h2>
          <p>
            Practical skills, built by the community.
            <br />
            Ready for the agents you already use.
          </p>
          <a href="https://skills.sh" target="_blank" rel="noreferrer">
            Explore the ecosystem <ArrowUpRight size={15} />
          </a>
        </div>
        <div className="feature-art" aria-hidden="true">
          <div className="art-back">
            <CodeIcon />
          </div>
          <div className="art-middle">
            <Layers size={42} strokeWidth={1.4} />
          </div>
          <div className="art-front">
            <Sparkles size={43} strokeWidth={1.35} />
            <span>SKILL.md</span>
          </div>
          <span className="art-orbit one" />
          <span className="art-orbit two" />
        </div>
      </div>
      <div className="discover-tools">
        <label className="search-box large">
          <Search size={18} />
          <input
            id="skill-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills, workflows, or authors…"
            aria-label="Search community skills"
          />
          <kbd>⌘ K</kbd>
        </label>
        <span className="catalog-source">
          <span className={live ? "live-dot" : "demo-dot"} />
          {loading ? "Connecting to skills.sh" : live ? "Live ecosystem results" : "Catalog unavailable"}
        </span>
      </div>
      {query.trim().length === 1 && <p className="search-guidance" role="status">Type at least 2 characters to search.</p>}
      {!search && (
        <div className="category-tabs">
          {([{ id: "all-time", label: "Popular" }, { id: "trending", label: "Trending" }, { id: "hot", label: "Hot" }, { id: "official", label: "Official" }] as const).map((item) => (
            <button
              className={view === item.id ? "active" : ""}
              onClick={() => setView(item.id)}
              key={item.id}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      {loadError && (
        <div className="notice">
          <CircleHelp size={16} />
          {loadError}
        </div>
      )}
      {loading && page === 0 ? (
        <div className="catalog-loading">
          <Loader2 className="spin" size={20} />
          Finding skills…
        </div>
      ) : (
        <div className="discover-grid">
          {catalog.map((skill) => {
            const installedSkill = installed.get(sourceKey(skill));
            return <article className="discover-skill" key={skill.catalogId || skill.id}>
              <div className="discover-skill-top">
                <SkillIcon skill={skill} />
                <div className="discover-labels">
                  {installedSkill && <Status status="connected" label="In your library" />}
                  {skill.official && <span className="official-label"><Check size={11} /> Official</span>}
                  <SafetyBadge safety={skill.safety} />
                </div>
              </div>
              <button className="discover-title" onClick={() => openResolved(skill)}>
                {skill.title}
                <ArrowUpRight size={17} />
              </button>
              <p>
                {skill.description ||
                  "Inspect the source instructions and bundled files before adding this skill."}
              </p>
              <div className="discover-skill-bottom">
                <span>
                  <Github size={12} />
                  {skill.sourceType ? `${skill.sourceType} · ` : ""}{skill.author || skill.source}
                </span>
                {typeof skill.installs === "number" && <span className="install-count"><ArrowDownToLine size={11} />{skill.installs.toLocaleString()}</span>}
                <button
                  className="icon-button"
                  aria-label={`Inspect ${skill.title}`}
                  onClick={() => openResolved(skill)}
                >
                  <Plus size={17} />
                </button>
              </div>
            </article>;
          })}
        </div>
      )}
      {hasMore && <div className="load-more"><button className="button" disabled={loading} onClick={() => setCatalogPage((value) => value + 1)}>{loading ? <Loader2 className="spin" size={15} /> : null}Load more</button></div>}
      {!loading && !catalog.length && (
        <Empty
          title="No skills found"
          description="Try a broader search, or add a repository directly."
        />
      )}
      {importing && (
        <Dialog title="Add from a source" onClose={() => setImporting(false)}>
          <form
            className="dialog-body"
            onSubmit={async (e) => {
              e.preventDefault();
              setSourceInspecting(true);
              setSourceError("");
              try {
                const result = await api<Partial<Skill>>("/skills/inspect", "POST", { source, name: sourceName || undefined });
                const fallbackName = sourceName || source.replace(/\.git$/, "").split("/").filter(Boolean).at(-1) || "skill";
                const inspected: Skill = {
                  id: result.id || result.catalogId || `inspect:${source}:${fallbackName}`,
                  name: result.name || fallbackName,
                  title: result.title || result.name || fallbackName,
                  description: result.description || "Inspect the source files and audit reports before adding this skill.",
                  author: result.author || source.replace(/^https?:\/\/(www\.)?github\.com\//, "").split("/")[0],
                  source: result.source || source,
                  kind: "third-party",
                  category: result.category || "Community",
                  icon: result.icon || "code",
                  color: result.color || "#d4eaa1",
                  selected: false,
                  enabled: true,
                  autoUpdate: false,
                  revision: result.revision || "",
                  versions: result.versions || [],
                  files: result.files || [],
                  requirements: result.requirements || [],
                  targets: result.targets || [],
                  updatedAt: result.updatedAt || new Date().toISOString(),
                  ...result,
                };
                setImporting(false);
                openResolved(inspected);
              } catch (inspectError) {
                setSourceError((inspectError as Error).message);
              } finally {
                setSourceInspecting(false);
              }
            }}
          >
            <p>
              Use a repository, a skill URL, or another source supported by
              Vercel Skills. Equip pins one exact revision for your computers.
            </p>
            <label className="field">
              Skill source
              <input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="vercel-labs/agent-skills"
                required
              />
            </label>
            {sourceError && <div className="notice error" role="alert"><AlertTriangle size={15} />{sourceError}</div>}
            <label className="field">
              Skill name{" "}
              <span className="field-hint">
                Optional for a source containing one skill
              </span>
              <input
                value={sourceName}
                onChange={(e) => setSourceName(e.target.value)}
                placeholder="e.g. vercel-react-best-practices"
              />
            </label>
            <div className="notice">
              <Github size={16} />
              Connected computers can resolve private sources using credentials
              that stay on that computer.
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                className="button"
                onClick={() => setImporting(false)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={sourceInspecting || !source}>
                {sourceInspecting ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <ArrowDownToLine size={16} />
                )}
                Inspect skill
              </button>
            </div>
            {sourceError && <button
              type="button"
              className="button source-fallback"
              disabled={sourceQueueing || !source}
              onClick={async () => {
                setSourceQueueing(true);
                try {
                  const result = await api<{ pending?: boolean }>("/skills/install", "POST", { source, name: sourceName || undefined });
                  setImporting(false);
                  notify(result.pending
                    ? "Source queued. A connected computer will resolve it with its existing repository access."
                    : "Skill added. Connected computers will receive the selected revision.");
                } catch (queueError) {
                  setSourceError((queueError as Error).message);
                } finally {
                  setSourceQueueing(false);
                }
              }}
            >
              {sourceQueueing ? <Loader2 size={16} className="spin" /> : <Laptop size={16} />}
              Resolve on a connected computer
            </button>}
          </form>
        </Dialog>
      )}
    </div>
  );
}
function CodeIcon() {
  return <span className="art-code">{"{ }"}</span>;
}

function Devices({
  workspace,
  connect,
  run,
}: {
  workspace: Workspace;
  connect: () => void;
  run: (fn: () => Promise<unknown>, message: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [disconnect, setDisconnect] = useState<Device>();
  const [conflict, setConflict] = useState<{ device: Device; receipt: Receipt }>();
  const [showAllReceipts, setShowAllReceipts] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<"retain" | "remove">("retain");
  const devices = workspace.devices.filter((d) => !d.disconnectedAt);
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>
            Your computers<span className="heading-dot">.</span>
          </h1>
          <p>The same toolkit, wherever you get to work.</p>
        </div>
        <button className="button primary" onClick={connect}>
          <Plus size={16} />
          Connect a computer
        </button>
      </div>
      <div className="workspace-summary">
        <span>
          <span className="online-dot on" />
          {devices.filter((d) => d.online && !d.disconnect).length} online
        </span>
        <span>
          <span className="online-dot off" />
          {devices.filter((d) => !d.online && !d.disconnect).length} offline
        </span>
        <span>
          <Layers size={15} />
          Agent locations detected on each computer
        </span>
      </div>
      {workspace.demo && (
        <div className="notice demo-notice">
          <CircleHelp size={16} />
          These are sample computers. Create an account and connect a real
          computer to receive installation receipts.
        </div>
      )}
      <div className="device-list">
        {devices.map((device) => {
          const conflicts = device.receipts.filter((receipt) => receipt.status === "conflicted");
          const visibleReceipts = conflicts.length && !showAllReceipts[device.id] ? conflicts : device.receipts;
          const status = deviceStatus(
            device,
            workspace.skills,
            workspace.generation,
            workspace.instructions,
          );
          const agentTypes = new Set(device.agents.map((agent) => agent.id)).size;
          const configurations = device.agents.reduce(
            (count, agent) => count + (agent.aliases?.length || 1),
            0,
          );
          return (
            <section className="device-section" key={device.id}>
              <div className="device-section-header">
                <span className="device-large-icon">
                  <OsIcon device={device} size={26} />
                </span>
                <div className="device-header-copy">
                  <h2>
                    {device.name}
                    {device.demo && <span className="custom-tag">Sample</span>}
                  </h2>
                  <p>
                    {device.os === "darwin"
                      ? "macOS"
                      : device.os === "win32"
                        ? "Windows"
                        : device.os === "linux"
                          ? "Linux"
                          : device.os}{" "}
                    · {device.arch} · {configurations} configurations across{" "}
                    {agentTypes} {agentTypes === 1 ? "agent type" : "agent types"}
                  </p>
                </div>
                <div className="device-health">
                  <Status
                    status={status}
                    label={
                      device.disconnect
                        ? "Disconnection pending"
                        : status === "synchronized"
                          ? "Online & synced"
                          : undefined
                    }
                  />
                  <small>Last sync {ago(device.lastSync)}</small>
                  {conflicts.length > 0 && (
                    <button
                      className="device-conflict-link"
                      onClick={() => {
                        setShowAllReceipts((current) => ({ ...current, [device.id]: false }));
                        setExpanded(device.id);
                      }}
                    >
                      Review {conflicts.length} {conflicts.length === 1 ? "conflict" : "conflicts"}
                    </button>
                  )}
                </div>
                <button
                  className="icon-button"
                  aria-label={`Inspect ${device.name}`}
                  onClick={() =>
                    setExpanded(expanded === device.id ? null : device.id)
                  }
                >
                  <ChevronDown
                    className={expanded === device.id ? "rotated" : ""}
                    size={20}
                  />
                </button>
              </div>
              <div className="device-agent-strip">
                {device.agents.map((agent, index) => (
                  <span key={`${agent.id}-${index}`}>
                    <span className="agent-glyph">{agent.name.charAt(0)}</span>
                    {agent.name}
                    <small>
                      {agent.profile ? `${agent.profile} · ` : ""}
                      {agent.aliases?.length || 1}{" "}
                      {(agent.aliases?.length || 1) === 1 ? "configuration" : "configurations"}
                    </small>
                  </span>
                ))}
                <button
                  className="text-link"
                  onClick={() =>
                    setExpanded(expanded === device.id ? null : device.id)
                  }
                >
                  View installations <ArrowRight size={13} />
                </button>
              </div>
              {device.disconnect ? (
                <div className="device-offline">
                  <WifiOff size={15} />
                  Disconnection pending. This computer will finish when it
                  reconnects.
                </div>
              ) : !device.online ? (
                <div className="device-offline">
                  <WifiOff size={15} />
                  Changes are queued. This computer will catch up when it
                  reconnects.
                </div>
              ) : null}
              {expanded === device.id && (
                <div className="device-expanded">
                  <div className="notice" style={{ display: "block" }}>
                    <label className="radio-option">
                      <input type="checkbox" checked={device.localSync?.enabled ?? false} disabled={workspace.demo || Boolean(device.disconnect)} onChange={event => run(() => api(`/devices/${device.id}/local-sync`, "PATCH", { enabled: event.target.checked }), event.target.checked ? "Local publishing enabled. New skills and custom edits will sync from this computer." : "Local publishing disabled. Dashboard updates still install.")} />
                      <span><strong>Publish local skills automatically</strong><small>New skill folders and custom-skill edits from these agent locations go to Equip, then your other computers. Edits to third-party skills are preserved for review.</small></span>
                    </label>
                    {device.localSync?.path && <p className="muted-copy">Shared skill store: <code>{device.localSync.path}</code></p>}
                    {device.localSync?.lastImport && <p className="muted-copy">Last local publication {ago(device.localSync.lastImport)}</p>}
                    {device.localSync?.error && <p className="error-text">Local publication needs attention: {device.localSync.error}</p>}
                    <p className="muted-copy">You can also publish a folder with <code>equip local add /path/to/skill</code>. Equip preserves preexisting folders and flags conflicting copies.</p>
                  </div>
                  <h3>Detected locations</h3>
                  {device.agents.map((agent, index) => (
                    <div className="agent-location-group" key={index}>
                      <div className="agent-location">
                        <strong>{agent.name}</strong>
                        <code>{agent.path}</code>
                        <span>
                          {agent.project ? "Project: " + agent.project : "Global"}
                          {" · "}{(agent.aliases?.length ?? 0) > 1 ? "Shared skill folder" : agent.profile || "default"}
                        </span>
                      </div>
                      {(agent.aliases?.length ?? 0) > 1 && agent.aliases?.map((alias) => (
                        <div className="agent-location alias" key={`${alias.profile}:${alias.path}`}>
                          <strong>{alias.profile}</strong>
                          <code>{alias.path}</code>
                          <span>Same physical skill root</span>
                        </div>
                      ))}
                    </div>
                  ))}
                  <div className="receipt-heading">
                    <h3>{conflicts.length && !showAllReceipts[device.id] ? "Conflicts" : "Installation receipts"}</h3>
                    {conflicts.length > 0 && (
                      <button className="text-link" onClick={() => setShowAllReceipts((current) => ({ ...current, [device.id]: !current[device.id] }))}>
                        {showAllReceipts[device.id] ? "Show conflicts" : `All installations (${device.receipts.length})`}
                      </button>
                    )}
                  </div>
                  {device.receipts.length ? (
                    <div className="receipt-table">
                      {visibleReceipts.map((r, i) => (
                        <div className="receipt-row" key={i}>
                          <span>
                            <strong>
                              {(r.kind === "instructions" ? workspace.instructions?.find((item) => item.id === r.skillId) : workspace.skills.find((s) => s.id === r.skillId))
                                ?.title || r.skillId}
                            </strong>
                            <small>
                              {r.agent}
                              {r.managed === false
                                ? r.status === "conflicted" ? " · Preexisting installation" : " · Existing matching installation"
                                : ""}
                              {r.message ? " · " + r.message : ""}
                            </small>
                          </span>
                          <code>{r.status === "conflicted" && !r.revision ? "No baseline" : revision(r.revision)}</code>
                          <Status status={r.status} />
                          {r.status === "conflicted" && (
                            <div className="conflict-actions">
                              <button
                                className="button small conflict-review-button"
                                onClick={() => setConflict({ device, receipt: r })}
                              >
                                Review differences
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="muted-copy">
                      No receipts yet. The connected worker will report each
                      installation.
                    </p>
                  )}
                  <div className="device-expanded-footer">
                    <span>
                      {device.demo
                        ? "Sample data, not a device receipt"
                        : "Only this computer’s local agents are connected."}
                    </span>
                    {!device.disconnect && (
                      <button
                        className="text-link danger"
                        onClick={() => {
                          setDisconnect(device);
                          setMode("retain");
                        }}
                      >
                        Disconnect computer
                      </button>
                    )}
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>
      {!devices.length && (
        <Empty
          title="Your first computer is one command away"
          description="Connect a computer and Equip will detect its agents, install your skills, and keep them synchronized."
        >
          <button className="button primary" onClick={connect}>
            Connect a computer <ArrowRight size={16} />
          </button>
        </Empty>
      )}
      <div className="cloud-boundary">
        <Monitor size={22} />
        <div>
          <h3>Desktop and cloud destinations</h3>
          <p>Claude Desktop’s local Code sessions use the detected Claude Code locations. ChatGPT Desktop supports importing Claude Code skills with automatic updates in Settings → Import. Enable that native import separately in each desktop account.</p>
          <p>ChatGPT account skills and Claude.ai / Cowork accept ZIP uploads. Open a skill and choose Download ZIP to export its exact revision. Account uploads remain manual because those account libraries do not expose a supported publishing API through Equip’s integrations. A download is not an installation receipt.</p>
          <p>A hosted computer with filesystem access can run the same Equip installer and <code>equip connect --headless</code> inside that environment. It then reports its own installations. An ephemeral cloud session cannot keep a background worker after its environment is destroyed.</p>
          <p><a href="https://learn.chatgpt.com/docs/import" target="_blank" rel="noreferrer">ChatGPT desktop import <ExternalLink size={12} /></a>{" · "}<a href="https://code.claude.com/docs/en/desktop#use-skills" target="_blank" rel="noreferrer">Claude Desktop skills <ExternalLink size={12} /></a>{" · "}<a href="https://help.openai.com/en/articles/20001066-skills-in-chatgpt" target="_blank" rel="noreferrer">ChatGPT account skills <ExternalLink size={12} /></a></p>
        </div>
      </div>
      {disconnect && (
        <Dialog
          title={`Disconnect ${disconnect.name}?`}
          onClose={() => setDisconnect(undefined)}
        >
          <div className="dialog-body">
            <p>
              Choose what should happen to Equip-managed skills. Your own skill
              folders are always preserved.
            </p>
            <label className="radio-option">
              <input
                type="radio"
                name="disconnect"
                checked={mode === "retain"}
                onChange={() => setMode("retain")}
              />
              <span>
                <strong>Keep installed skills</strong>
                <small>
                  Stop synchronization and leave the current files on this
                  computer.
                </small>
              </span>
            </label>
            <label className="radio-option">
              <input
                type="radio"
                name="disconnect"
                checked={mode === "remove"}
                onChange={() => setMode("remove")}
              />
              <span>
                <strong>Remove managed skills</strong>
                <small>
                  The computer removes unchanged managed files before
                  disconnecting. Offline computers apply this when they
                  reconnect.
                </small>
              </span>
            </label>
            <div className="dialog-actions">
              <button
                className="button"
                onClick={() => setDisconnect(undefined)}
              >
                Cancel
              </button>
              <button
                className="button danger-button"
                onClick={async () => {
                  await run(
                    () =>
                      api(`/devices/${disconnect.id}/disconnect`, "POST", {
                        mode,
                      }),
                    "Disconnection requested. The computer will confirm completion.",
                  );
                  setDisconnect(undefined);
                }}
              >
                Disconnect computer
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {conflict && (
        <SkillConflict
          skill={conflict.receipt.kind === "instructions"
            ? (() => { const item = workspace.instructions?.find((instruction) => instruction.id === conflict.receipt.skillId); return item ? instructionsAsSkill(item) : undefined; })()
            : workspace.skills.find((skill) => skill.id === conflict.receipt.skillId)}
          documentKind={conflict.receipt.kind}
          device={workspace.devices.find(device => device.id === conflict.device.id) || conflict.device}
          receipt={conflict.receipt}
          onClose={() => setConflict(undefined)}
          onResolve={async (action, expectedRevision) => {
            let accepted = false;
            let resolutionError: unknown;
            const expectedLocalRevision = conflict.receipt.localFiles ? await reviewedFilesRevision(conflict.receipt.localFiles) : undefined;
            await run(
              async () => {
                try {
                  await api(conflict.receipt.kind === "instructions" ? `/devices/${conflict.device.id}/instructions/resolve` : `/devices/${conflict.device.id}/resolve`, "POST", {
                    ...(conflict.receipt.kind === "instructions" ? { instructionId: conflict.receipt.skillId } : { skillId: conflict.receipt.skillId }),
                    agent: conflict.receipt.agent,
                    profile: conflict.receipt.profile,
                    project: conflict.receipt.project,
                    action,
                    expectedRevision,
                    expectedLocalRevision,
                  });
                  accepted = true;
                } catch (error) {
                  resolutionError = error;
                  throw error;
                }
              },
              action === "publish" ? "Local version published. Waiting for device receipts." : "Choice queued. Waiting for this computer to confirm it.",
            );
            if (!accepted) throw resolutionError instanceof Error ? resolutionError : new Error("The choice was not queued.");
          }}
        />
      )}
    </div>
  );
}

function Activity({ workspace }: { workspace: Workspace }) {
  const [filter, setFilter] = useState("all");
  const activity = workspace.activity.filter(
    (a) => filter === "all" || a.status === filter,
  );
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>
            Activity<span className="heading-dot">.</span>
          </h1>
          <p>Every change. Every receipt. Nothing left to guess.</p>
        </div>
        <label className="filter-select">
          <SlidersHorizontal size={16} />
          <select
            aria-label="Filter activity"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All activity</option>
            <option value="synchronized">Synchronized</option>
            <option value="pending">Pending</option>
            <option value="failed">Failed</option>
            <option value="conflicted">Conflicts</option>
          </select>
        </label>
      </div>
      <div className="activity-feed">
        {activity.map((a) => (
          <div className="activity-feed-row" key={a.id}>
            <span className={`activity-feed-icon ${a.status}`}>
              {a.type.includes("publish") ? (
                <Sparkles size={19} />
              ) : a.status === "failed" ? (
                <AlertTriangle size={19} />
              ) : (
                <RefreshCw size={19} />
              )}
            </span>
            <div>
              <h3>{a.title}</h3>
              <p>{a.description}</p>
              <small>{new Date(a.timestamp).toLocaleString()}</small>
            </div>
            <Status status={a.status} />
          </div>
        ))}
      </div>
      {!activity.length && (
        <Empty
          title="A clean slate"
          description="Changes to your library and device installation results will appear here."
        />
      )}
      <p className="page-note">
        A saved dashboard change is pending until each selected computer reports
        a successful installation.
      </p>
    </div>
  );
}

function Settings({
  workspace,
  auth,
  run,
}: {
  workspace: Workspace;
  auth: () => void;
  run: (fn: () => Promise<unknown>, message: string) => Promise<void>;
}) {
  const [compatibility, setCompatibility] = useState<any>();
  useEffect(() => {
    api("/compatibility")
      .then(setCompatibility)
      .catch(() => {});
  }, []);
  return (
    <div className="page settings-page">
      <div className="page-heading">
        <div>
          <h1>
            Workspace settings<span className="heading-dot">.</span>
          </h1>
          <p>Simple defaults. Clear boundaries.</p>
        </div>
      </div>
      <section className="settings-section">
        <h2>Your account</h2>
        <div className="settings-row">
          <div>
            <strong>{workspace.name}</strong>
            <p>{workspace.email || "You are exploring the demo workspace."}</p>
          </div>
          <button className="button" onClick={auth}>
            {workspace.demo ? "Create an account" : "Manage account"}
          </button>
        </div>
      </section>
      <section className="settings-section">
        <h2>Installation defaults</h2>
        <div className="settings-row">
          <div>
            <strong>All connected computers and detected agents</strong>
            <p>
              New agents receive your selected skills automatically. Set
              exceptions in a skill’s Destinations tab.
            </p>
          </div>
          <Status status="connected" label="Default" />
        </div>
        <div className="settings-row">
          <div>
            <strong>Manual approval for community updates</strong>
            <p>
              New skills start with manual updates. Choose automatic updates per
              skill. Published custom skills synchronize immediately.
            </p>
          </div>
          <span className="category-label">Per-skill control</span>
        </div>
      </section>
      <section className="settings-section">
        <h2>Agent compatibility</h2>
        <div className="settings-row">
          <div>
            <strong>Powered by the current Vercel Skills definitions</strong>
            <p>
              {compatibility
                ? `${compatibility.agents?.length || 0} supported agents · Skills ${compatibility.version}`
                : "Loading compatibility definitions…"}
            </p>
          </div>
          <a
            className="button"
            href="https://github.com/vercel-labs/skills"
            target="_blank"
            rel="noreferrer"
          >
            View upstream <ArrowUpRight size={15} />
          </a>
        </div>
        {compatibility && (
          <div className="agent-tags">
            {compatibility.agents?.map((a: any) => (
              <span key={a.id}>
                {a.name}
                {!a.globalPath ? <small> · Project only</small> : null}
              </span>
            ))}
          </div>
        )}
      </section>
      <section className="settings-section">
        <h2>Privacy & installation boundaries</h2>
        <p>
          Equip connects to local agent skill folders. It does not collect agent
          account credentials, copy account logins, or install into separately
          hosted cloud accounts. Private repository access uses existing device
          credentials where the source allows it.
        </p>
      </section>
    </div>
  );
}

function ConnectDialog({
  onClose,
  devices,
  skills,
  generation,
}: {
  onClose: () => void;
  devices: Device[];
  skills: Skill[];
  generation: number;
}) {
  const [platform, setPlatform] = useState("mac");
  const [copied, setCopied] = useState(false);
  const server =
    location.port === "5173"
      ? `${location.protocol}//${location.hostname}:4310`
      : location.origin;
  const command =
    platform === "windows"
      ? `irm ${server}/install.ps1 | iex`
      : `curl -fsSL ${server}/install.sh | sh`;
  const real = devices.filter((d) => !d.demo);
  return (
    <Dialog title="Connect a computer" onClose={onClose}>
      <div className="dialog-body connect-dialog">
        <div className="connect-illustration">
          <Laptop size={44} strokeWidth={1.2} />
          <span />
          <Logo />
        </div>
        <h3>One command. Your whole toolkit.</h3>
        <p>
          Run this on the computer you want to connect. Equip installs the CLI
          and background sync, then starts secure device approval.
        </p>
        <div className="segmented">
          {[
            { id: "mac", label: "macOS" },
            { id: "linux", label: "Linux" },
            { id: "windows", label: "Windows" },
          ].map((p) => (
            <button
              key={p.id}
              className={platform === p.id ? "active" : ""}
              onClick={() => setPlatform(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="command-box">
          <code>{command}</code>
          <button
            aria-label="Copy installation command"
            onClick={async () => {
              await navigator.clipboard.writeText(command);
              setCopied(true);
            }}
          >
            {copied ? <Check size={17} /> : <Copy size={17} />}
          </button>
        </div>
        <div className="connection-steps">
          <div>
            <span>1</span>
            <div>
              <strong>Install & approve</strong>
              <p>
                Press Enter to open your browser. On a headless computer, use
                the displayed URL and device code.
              </p>
            </div>
          </div>
          <div>
            <span>2</span>
            <div>
              <strong>Watch your agents appear</strong>
              <p>
                Equip detects supported agents and their actual skill locations.
              </p>
            </div>
          </div>
          <div>
            <span>3</span>
            <div>
              <strong>You’re equipped</strong>
              <p>
                Your selected revisions install automatically. The background
                service keeps them in sync.
              </p>
            </div>
          </div>
        </div>
        <div className="connect-waiting">
          <span className="live-dot" />
          {real.length
            ? `${real.length} real ${real.length === 1 ? "computer" : "computers"} connected. New connections appear automatically.`
            : "Ready for your first connection. It will appear here automatically."}
        </div>
        {real.length > 0 && (
          <div className="connection-live-list" aria-live="polite">
            {real.slice(-3).map((device) => (
              <div key={device.id}>
                <Laptop size={17} />
                <span>
                  <strong>{device.name}</strong>
                  <small>
                    {!device.agents.length
                      ? "Detecting installed agents"
                      : `${device.agents.reduce((count, agent) => count + (agent.aliases?.length || 1), 0)} configurations detected · ${deviceStatus(device, skills, generation) === "synchronized" ? "Selected revisions installed" : "Waiting for confirmed installation"}`}
                  </small>
                </span>
                <Status status={deviceStatus(device, skills, generation)} />
              </div>
            ))}
          </div>
        )}
        <p className="fine-print">
          Already installed? Run <code>equip connect</code>. The installer sets
          up the CLI, its runtime, and automatic background sync.
        </p>
      </div>
    </Dialog>
  );
}

function AuthDialog({
  workspace,
  emailSignIn,
  initialError,
  retryConfig,
  onClose,
  onSuccess,
}: {
  workspace: Workspace;
  emailSignIn: boolean | null;
  initialError: string;
  retryConfig: () => Promise<void>;
  onClose: () => void;
  onSuccess: (message: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"register" | "login">("register");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [sent, setSent] = useState(false);
  const sendEmailLink = async () => {
    await api("/auth/email", "POST", {
      email,
      name: name.trim() || undefined,
      returnTo: `${location.pathname}${location.search}`,
    });
    setSent(true);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (emailSignIn) {
        await sendEmailLink();
        return;
      }
      await api(`/auth/${mode}`, "POST", { name, email, password });
      await onSuccess(
        mode === "register"
          ? "Your account is ready. Connect your first computer."
          : "Signed in. Your workspace is ready.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={
        workspace.demo
          ? mode === "register"
            ? "Make yourself at home."
            : "Welcome back."
          : "Your account"
      }
      onClose={onClose}
    >
      <div className="dialog-body">
        {!workspace.demo ? (
          <>
            <p>
              Signed in as <strong>{workspace.email}</strong>.
            </p>
            <button
              className="button"
              onClick={async () => {
                await api("/auth/logout", "POST");
                await onSuccess("Signed out.");
              }}
            >
              <LogOut size={16} />
              Sign out
            </button>
          </>
        ) : (
          <>
            <p>
              {emailSignIn === true
                ? "Use your email to open your personal workspace and connect real computers."
                : emailSignIn === false
                  ? "Create a personal workspace to connect real computers. The demo library stays separate."
                  : "Checking the available sign-in method for this workspace."}
            </p>
            {emailSignIn === null ? (
              <div className="auth-config-loading" role="status">
                <Loader2 className="spin" size={18} />
                <span>Checking sign-in options…</span>
                <button className="button" onClick={() => void retryConfig()}>
                  Retry now
                </button>
              </div>
            ) : emailSignIn && sent ? (
              <div className="auth-sent" role="status">
                <Check size={20} />
                <div>
                  <strong>Check your inbox</strong>
                  <p>
                    We sent a sign-in link to <strong>{email}</strong>. You can
                    close this window after opening it.
                  </p>
                </div>
                <button
                  className="button full-width"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await sendEmailLink();
                    } catch (e) {
                      setError((e as Error).message);
                      setSent(false);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? <Loader2 className="spin" size={16} /> : null}
                  Send another link
                </button>
              </div>
            ) : (
              <form onSubmit={submit} className="auth-form">
                {(emailSignIn || mode === "register") && (
                  <label className="field">
                    Your name
                    {emailSignIn ? (
                      <span className="field-hint">
                        Optional for your first account
                      </span>
                    ) : null}
                    <input
                      autoComplete="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required={!emailSignIn}
                      placeholder="Alex Morgan"
                    />
                  </label>
                )}
                <label className="field">
                  Email address
                  <input
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="you@example.com"
                  />
                </label>
                {!emailSignIn && (
                  <label className="field">
                    Password
                    <input
                      type="password"
                      autoComplete={
                        mode === "register"
                          ? "new-password"
                          : "current-password"
                      }
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      minLength={10}
                      required
                      placeholder="At least 10 characters"
                    />
                  </label>
                )}
                {error && (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
                <button disabled={busy} className="button primary full-width">
                  {busy ? <Loader2 className="spin" size={16} /> : null}
                  {emailSignIn
                    ? "Send sign-in link"
                    : mode === "register"
                      ? "Create your account"
                      : "Sign in"}
                  <ArrowRight size={16} />
                </button>
              </form>
            )}
            {!emailSignIn && (
              <button
                className="auth-switch"
                onClick={() =>
                  setMode(mode === "register" ? "login" : "register")
                }
              >
                {mode === "register"
                  ? "Already have an account? Sign in"
                  : "New to Equip? Create an account"}
              </button>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

function Approval({
  code,
  demo,
  auth,
  onClose,
  refresh,
}: {
  code: string;
  demo: boolean;
  auth: () => void;
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const [device, setDevice] = useState<any>();
  const [error, setError] = useState("");
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [entry, setEntry] = useState(code);
  useEffect(() => {
    if (!entry) return;
    api(`/device/authorization?code=${encodeURIComponent(entry)}`)
      .then(setDevice)
      .catch((e) => setError(e.message));
  }, [entry]);
  return (
    <Dialog
      title={approved ? "Computer approved" : "Approve this computer"}
      onClose={onClose}
    >
      <div className="dialog-body">
        <div className="approval-icon">
          {approved ? <Check size={34} /> : <Laptop size={34} />}
        </div>
        {device && (
          <>
            <h3>{device.name}</h3>
            <p>{device.os} · Device authorization</p>
          </>
        )}
        <label className="field">
          Confirm the code shown in your terminal
          <input
            className="device-code"
            value={entry}
            onChange={(e) => {
              setEntry(e.target.value.toUpperCase());
              setError("");
            }}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {approved ? (
          <>
            <p>
              Your computer can now install and synchronize your selected
              skills. You can return to your terminal.
            </p>
            <button className="button primary full-width" onClick={onClose}>
              Back to your workspace <ArrowRight size={16} />
            </button>
          </>
        ) : (
          <>
            <p>
              Only approve this request if you started it on a computer you
              trust. Equip connects local skill folders, without accessing your
              agent logins.
            </p>
            {demo ? (
              <button className="button primary full-width" onClick={auth}>
                Sign in to approve <ArrowRight size={16} />
              </button>
            ) : (
              <button
                disabled={!device || busy}
                className="button primary full-width"
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api("/device/approve", "POST", { userCode: entry });
                    setApproved(true);
                    await refresh();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? (
                  <Loader2 className="spin" size={16} />
                ) : (
                  <Check size={16} />
                )}
                Approve computer
              </button>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

function ClockIcon() {
  return <RefreshCw size={16} />;
}

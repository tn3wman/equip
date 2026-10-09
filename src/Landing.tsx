import { useEffect, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Blocks,
  Check,
  Copy,
  FileDiff,
  FilePen,
  History,
  Laptop,
  ListChecks,
  Monitor,
  RefreshCw,
  Server,
  SquareTerminal,
  WifiOff,
} from "lucide-react";
import { Logo } from "./components";

/* Section anchors the landing owns; the app treats these hashes as landing navigation. */
export const landingSections = ["top", "product", "how", "install", "landing-main"];

type LandingProps = { onSignIn: () => void; onExplore: () => void; installCommand: string };

const skills = [
  { name: "frontend-design", source: "anthropics/skills", rev: "a41c9e2" },
  { name: "pr-review", source: "tn3wman/skills", rev: "7be03f1" },
  { name: "release-notes", source: "custom", rev: "e19d4b8" },
  { name: "infra-runbook", source: "vercel-labs/agent-skills", rev: "3c0fa75" },
];

const computers = [
  { name: "MacBook Pro", detail: "Claude Code, Codex", icon: Laptop, online: true },
  { name: "Linux workstation", detail: "Codex", icon: Server, online: true },
  { name: "ThinkPad", detail: "Offline, will catch up", icon: Monitor, online: false },
];

const steps = [
  {
    icon: ListChecks,
    title: "Choose skills",
    body: "Pick skills from Vercel Skills, GitHub, or your own repo. Set your global instructions once.",
  },
  {
    icon: SquareTerminal,
    title: "Connect a computer",
    body: "Run the installer, then equip connect. A background service starts and detects every agent profile.",
    code: ["curl … | sh", "equip connect"],
  },
  {
    icon: RefreshCw,
    title: "Everything stays in sync",
    body: "The same pinned revisions land in every agent on every computer, and each one confirms it.",
  },
];

const features = [
  {
    icon: History,
    title: "Pinned revisions & rollback",
    body: "Every skill installs at an exact revision. Roll every computer back to a previous revision from the dashboard.",
  },
  {
    icon: FileDiff,
    title: "Local change review",
    body: "Edited a skill on a laptop? Equip holds the change for a decision before replacing it.",
  },
  {
    icon: BadgeCheck,
    title: "Device receipts",
    body: "Each computer reports what it actually installed. No guessing which machine is behind.",
  },
  {
    icon: FilePen,
    title: "Custom skills & instructions",
    body: "Publish your own skills and keep CLAUDE.md and AGENTS.md identical everywhere.",
  },
  {
    icon: WifiOff,
    title: "Works offline, catches up",
    body: "A closed laptop misses nothing. It picks up the latest revisions on its next check after reconnecting.",
  },
  {
    icon: Blocks,
    title: "Built on Vercel Skills",
    body: "One install format for 40+ agents, from Claude Code and Codex to Cursor and Gemini CLI.",
  },
];

const agents = ["Claude Code", "Codex", "Cursor", "Windsurf", "GitHub Copilot", "Gemini CLI", "OpenCode", "Amp"];

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(key);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), 2000);
  };
  return { copied, copy };
}

function CopyButton({ label, copied, onCopy }: { label: string; copied: boolean; onCopy: () => void }) {
  return (
    <button type="button" className="landing-copy" onClick={onCopy} aria-label={copied ? "Copied" : label}>
      {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      <span aria-hidden="true">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function ProductFrame() {
  return (
    <div className="landing-frame" role="img" aria-label="Equip dashboard: four skills installed on three of three computers">
      <div className="landing-frame-bar" aria-hidden="true">
        <span />
        <span />
        <span />
        <em>equip / skills</em>
      </div>
      <div className="landing-frame-body" aria-hidden="true">
        <div className="landing-frame-rail">
          <div className="landing-frame-mark">
            <Logo />
          </div>
          <i className="active" />
          <i />
          <i />
          <i />
        </div>
        <div className="landing-frame-main">
          <div className="landing-frame-head">
            <strong>Skills</strong>
            <span className="landing-frame-sync">
              <b />
              Synced 12s ago
            </span>
          </div>
          <div className="landing-frame-table">
            {skills.map((skill, index) => (
              <div className="landing-frame-row" key={skill.name} style={{ "--row": index } as CSSProperties}>
                <div className="landing-frame-name">
                  <strong>{skill.name}</strong>
                  <small>{skill.source}</small>
                </div>
                <code>{skill.rev}</code>
                <div className="landing-frame-meter">
                  <small>Installed on 3 of 3 computers</small>
                  <span>
                    <b />
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="landing-frame-side">
          <small className="landing-frame-label">Computers</small>
          {computers.map(({ name, detail, icon: Icon, online }) => (
            <div className={`landing-frame-device ${online ? "" : "offline"}`} key={name}>
              <Icon size={16} />
              <div>
                <strong>{name}</strong>
                <small>{detail}</small>
              </div>
              <i />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Landing({ onSignIn, onExplore, installCommand }: LandingProps): JSX.Element {
  const { copied, copy } = useCopy();
  const [platform, setPlatform] = useState<"unix" | "windows">("unix");
  // The Windows installer sits beside install.sh on the same origin.
  const origin = installCommand.match(/(https?:\/\/\S+?)\/install\.sh/)?.[1] ?? window.location.origin;
  const commands = {
    unix: installCommand,
    windows: `irm ${origin}/install.ps1 | iex`,
  };
  const tabs = [
    { id: "unix", label: "macOS / Linux" },
    { id: "windows", label: "Windows" },
  ] as const;

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = platform === "unix" ? "windows" : "unix";
    setPlatform(next);
    document.getElementById(`landing-tab-${next}`)?.focus();
  };

  return (
    <div className="landing">
      <a className="landing-skip" href="#landing-main">
        Skip to content
      </a>
      <header className="landing-nav">
        <div className="landing-container landing-nav-inner">
          <a className="landing-brand" href="#top" aria-label="Equip home">
            <Logo />
            <span>equip</span>
          </a>
          <nav aria-label="Primary" className="landing-nav-links">
            <a href="#product">Product</a>
            <a href="#how">How it works</a>
            <a href="#install">Install</a>
          </nav>
          <div className="landing-nav-actions">
            <button type="button" className="landing-text-button" onClick={onSignIn}>
              Sign in
            </button>
            <button type="button" className="landing-button primary small" onClick={onExplore}>
              Explore the demo
            </button>
          </div>
        </div>
      </header>

      <main id="landing-main">
        <section className="landing-hero" id="top" aria-labelledby="landing-title">
          <div className="landing-hero-bg" aria-hidden="true" />
          <div className="landing-container landing-hero-inner">
            <p className="landing-eyebrow">
              <span />
              Skill and instruction sync for AI agents
            </p>
            <h1 id="landing-title">
              Your agents, equipped<em>.</em>
              <br />
              On every computer<em>.</em>
            </h1>
            <p className="landing-lede">
              Pick skills once. Equip installs the same pinned revisions into Claude Code, Codex, Cursor, and 40+ more
              agents on every machine you own.
            </p>
            <div className="landing-cta-row">
              <button type="button" className="landing-button primary" onClick={onSignIn}>
                Create an account
                <ArrowRight size={17} aria-hidden="true" />
              </button>
              <button type="button" className="landing-button secondary" onClick={onExplore}>
                Explore the demo
              </button>
            </div>
            <div className="landing-command">
              <span className="landing-prompt" aria-hidden="true">
                $
              </span>
              <code>{installCommand}</code>
              <CopyButton
                label="Copy install command"
                copied={copied === "hero"}
                onCopy={() => void copy("hero", installCommand)}
              />
            </div>
          </div>
          <div className="landing-container landing-frame-wrap" id="product">
            <ProductFrame />
          </div>
        </section>

        <section className="landing-agents" aria-label="Supported agents">
          <div className="landing-container">
            <p>Installs into the agents you already use</p>
            <ul>
              {agents.map((agent) => (
                <li key={agent}>{agent}</li>
              ))}
              <li className="more">and 40+ more</li>
            </ul>
          </div>
        </section>

        <section className="landing-section" id="how" aria-labelledby="landing-how">
          <div className="landing-container">
            <header className="landing-section-head">
              <p className="landing-kicker">How it works</p>
              <h2 id="landing-how">Set it up once. Never copy a skill folder again.</h2>
            </header>
            <ol className="landing-steps">
              {steps.map(({ icon: Icon, title, body, code }, index) => (
                <li key={title}>
                  <div className="landing-step-top">
                    <span className="landing-step-num">{String(index + 1).padStart(2, "0")}</span>
                    <Icon size={20} aria-hidden="true" />
                  </div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                  {code && (
                    <div className="landing-step-code">
                      {code.map((line) => (
                        <code key={line}>
                          <span aria-hidden="true">$ </span>
                          {line}
                        </code>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="landing-section" aria-labelledby="landing-features">
          <div className="landing-container">
            <header className="landing-section-head">
              <p className="landing-kicker">Product</p>
              <h2 id="landing-features">Built for the fleet you actually have.</h2>
            </header>
            <ul className="landing-features">
              {features.map(({ icon: Icon, title, body }) => (
                <li key={title}>
                  <span className="landing-feature-icon">
                    <Icon size={18} aria-hidden="true" />
                  </span>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="landing-section" id="install" aria-labelledby="landing-install">
          <div className="landing-container landing-install">
            <header className="landing-section-head">
              <p className="landing-kicker">Install</p>
              <h2 id="landing-install">One command per computer.</h2>
              <p>
                The installer adds the equip CLI and a background service. Connect once and it keeps every agent
                current, even after a week offline.
              </p>
            </header>
            <div className="landing-terminal">
              <div className="landing-tabs" role="tablist" aria-label="Operating system">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    id={`landing-tab-${tab.id}`}
                    type="button"
                    role="tab"
                    aria-selected={platform === tab.id}
                    aria-controls="landing-terminal-panel"
                    tabIndex={platform === tab.id ? 0 : -1}
                    onClick={() => setPlatform(tab.id)}
                    onKeyDown={onTabKey}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <div
                className="landing-terminal-body"
                id="landing-terminal-panel"
                role="tabpanel"
                aria-labelledby={`landing-tab-${platform}`}
              >
                <div className="landing-terminal-line">
                  <code>
                    <span aria-hidden="true">{platform === "unix" ? "$ " : "> "}</span>
                    {commands[platform]}
                  </code>
                  <CopyButton
                    label="Copy install command"
                    copied={copied === "install"}
                    onCopy={() => void copy("install", commands[platform])}
                  />
                </div>
                <div className="landing-terminal-line">
                  <code>
                    <span aria-hidden="true">$ </span>equip connect
                  </code>
                </div>
                <p className="landing-terminal-note"># Opens the browser to approve this computer</p>
                <div className="landing-terminal-line">
                  <code>
                    <span aria-hidden="true">$ </span>equip status
                  </code>
                </div>
                <p className="landing-terminal-note"># 4 skills · 2 agents · in sync</p>
                <div className="landing-terminal-line">
                  <code>
                    <span aria-hidden="true">$ </span>equip sync
                  </code>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="landing-final" aria-labelledby="landing-final-title">
          <div className="landing-container landing-final-inner">
            <h2 id="landing-final-title">
              Equip every agent<em>.</em> Today<em>.</em>
            </h2>
            <p>Create an account, choose your skills, and connect your first computer with one command.</p>
            <div className="landing-cta-row">
              <button type="button" className="landing-button primary" onClick={onSignIn}>
                Create an account
                <ArrowRight size={17} aria-hidden="true" />
              </button>
              <button type="button" className="landing-button ghost" onClick={onExplore}>
                Explore the demo
              </button>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-container landing-footer-inner">
          <div className="landing-brand quiet">
            <Logo small />
            <span>Equip</span>
          </div>
          <p>Built on Vercel Skills</p>
          <p>© Equip</p>
          <a href="https://github.com/tn3wman/equip" target="_blank" rel="noreferrer">
            GitHub
            <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        </div>
      </footer>
    </div>
  );
}

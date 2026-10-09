import { createPortal } from "react-dom";
import {
  useEffect,
  useRef,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  X,
  Check,
  Clock3,
  AlertCircle,
  WifiOff,
  GitBranch,
  Monitor,
  Laptop,
  Terminal,
  Layers,
  Code2,
  Palette,
  FileText,
  Globe,
  FlaskConical,
  Sparkles,
  ShieldCheck,
} from "lucide-react";
import type { Device, Skill, SyncStatus } from "../shared/types";

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <div className={`logo ${small ? "small" : ""}`}>
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M8 6h17v5H13v3h10v5H13v3h12v5H8z" />
      </svg>
    </div>
  );
}
export function SkillIcon({ skill }: { skill: Pick<Skill, "icon" | "color"> }) {
  const icons: Record<string, typeof Code2> = {
    code: Code2,
    react: Code2,
    design: Palette,
    globe: Globe,
    browser: Globe,
    terminal: Terminal,
    document: FileText,
    test: FlaskConical,
    sparkles: Sparkles,
    security: ShieldCheck,
  };
  const Icon = icons[skill.icon] || Layers;
  return (
    <span className={`skill-icon ${skill.color || "lavender"}`}>
      <Icon size={22} strokeWidth={1.65} />
    </span>
  );
}
export function Status({
  status,
  label,
}: {
  status: SyncStatus | "disabled" | "draft" | "connected";
  label?: string;
}) {
  const icons = {
    synchronized: Check,
    pending: Clock3,
    offline: WifiOff,
    conflicted: GitBranch,
    failed: AlertCircle,
    disabled: Clock3,
    draft: FileText,
    connected: Check,
  };
  const Icon = icons[status];
  return (
    <span className={`status ${status}`}>
      <Icon size={12} />
      {label ||
        {
          synchronized: "Synced",
          pending: "Pending",
          offline: "Offline",
          conflicted: "Conflict",
          failed: "Failed",
          disabled: "Disabled",
          draft: "Draft",
          connected: "Connected",
        }[status]}
    </span>
  );
}
export function OsIcon({
  device,
  size = 19,
}: {
  device: Pick<Device, "os">;
  size?: number;
}) {
  return device.os.toLowerCase().includes("linux") ? (
    <Terminal size={size} />
  ) : device.os.toLowerCase().includes("windows") ? (
    <Monitor size={size} />
  ) : (
    <Laptop size={size} />
  );
}
export function ago(date?: string) {
  if (!date) return "Not yet";
  const delta = Math.max(0, Date.now() - Date.parse(date));
  if (delta < 60000) return "Just now";
  if (delta < 3600000) return `${Math.floor(delta / 60000)}m ago`;
  if (delta < 86400000) return `${Math.floor(delta / 3600000)}h ago`;
  return `${Math.floor(delta / 86400000)}d ago`;
}
export function revision(value: string) {
  return value?.replace(/^sha256:/, "").slice(0, 7) || "Unpublished";
}
/* Controls a focus trap may cycle through: enabled, rendered, and not opted out
   of the tab order. Disabled or hidden fields would otherwise trap focus on BODY. */
export function tabbable(root: HTMLElement | null) {
  if (!root) return [];
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button,input,textarea,select,a[href],[tabindex]:not([tabindex="-1"])',
    ),
  ].filter(
    (el) =>
      !(el as HTMLButtonElement).disabled &&
      el.getAttribute("tabindex") !== "-1" &&
      el.offsetParent !== null,
  );
}
/* Modal surfaces (dialogs, the command palette, the skill drawer) can stack, so
   only the first to open captures page state and only the last to close restores
   it, whatever order they unmount in. The returned function reports whether this
   surface is the topmost one, so stacked dialogs answer keyboard events one at a
   time. The drawer passes inertPage=false because the app marks its own regions
   inert while leaving the drawer interactive. */
const modalStack: { token: symbol; inertPage: boolean }[] = [];
let pageState: { inert: boolean; overflow: string } | null = null;
export function useModalPage(inertPage = true) {
  const token = useRef(Symbol("modal")).current;
  useEffect(() => {
    const page = document.querySelector<HTMLElement>(".app, .landing");
    if (!modalStack.length) {
      pageState = { inert: page?.inert ?? false, overflow: document.body.style.overflow };
    }
    modalStack.push({ token, inertPage });
    if (page && inertPage) page.inert = true;
    document.body.style.overflow = "hidden";
    return () => {
      modalStack.splice(modalStack.findIndex((entry) => entry.token === token), 1);
      if (!modalStack.length && pageState) {
        document.body.style.overflow = pageState.overflow;
        if (page) page.inert = pageState.inert;
        pageState = null;
      } else if (page) page.inert = modalStack.some((entry) => entry.inertPage);
    };
  }, [token, inertPage]);
  return () => modalStack[modalStack.length - 1]?.token === token;
}
export function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const isTop = useModalPage();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === "Escape") close.current();
      if (e.key === "Tab") {
        const focusable = tabbable(ref.current);
        if (!focusable.length) return;
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`dialog ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="dialog-head">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
export function Empty({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <Layers size={35} strokeWidth={1.2} />
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}

export function navigateTabs(event: ReactKeyboardEvent<HTMLElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  );
  const i = tabs.indexOf(event.target as HTMLButtonElement);
  if (i < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (i + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
          tabs.length;
  tabs[next]?.focus();
  tabs[next]?.click();
}

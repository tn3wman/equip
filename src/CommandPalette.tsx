import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  CornerDownLeft,
  Plus,
  Search,
  Terminal,
  CircleHelp,
} from "lucide-react";
import { SkillIcon, useModalPage } from "./components";
import { pageMeta, type Page } from "./pages";
import type { Skill, Workspace } from "../shared/types";

export type PaletteCommand = {
  id: string;
  group: "Go to" | "Actions" | "Skills";
  label: string;
  hint?: string;
  keywords?: string;
  icon: ReactNode;
  run: () => void;
};

export function paletteCommands({
  workspace,
  navigate,
  openSkill,
  connect,
  create,
  help,
}: {
  workspace: Workspace;
  navigate: (page: Page) => void;
  openSkill: (skill: Skill) => void;
  connect: () => void;
  create: () => void;
  help: () => void;
}): PaletteCommand[] {
  const pages: PaletteCommand[] = pageMeta.map(({ id, label, icon: Icon }) => ({
    id,
    label,
    keywords: id === "discover" ? "skills search" : undefined,
    icon: <Icon size={16} />,
    group: "Go to" as const,
    run: () => navigate(id),
  }));
  const actions: PaletteCommand[] = [
    {
      id: "connect",
      group: "Actions",
      label: "Connect a computer",
      keywords: "install device machine",
      icon: <Terminal size={16} />,
      run: connect,
    },
    {
      id: "create",
      group: "Actions",
      label: "Create a skill",
      keywords: "new custom write",
      icon: <Plus size={16} />,
      run: create,
    },
    {
      id: "help",
      group: "Actions",
      label: "Help and getting started",
      icon: <CircleHelp size={16} />,
      run: help,
    },
  ];
  const skills: PaletteCommand[] = workspace.skills
    .filter((skill) => skill.selected)
    .map((skill) => ({
      id: `skill:${skill.id}`,
      group: "Skills",
      label: skill.title,
      hint: skill.kind === "custom" ? "Custom" : skill.source,
      keywords: `${skill.description} ${skill.author} ${skill.source}`,
      icon: <SkillIcon skill={skill} />,
      run: () => openSkill(skill),
    }));
  return [...pages, ...actions, ...skills];
}

function matches(command: PaletteCommand, query: string) {
  if (!query) return true;
  const haystack = `${command.label} ${command.hint ?? ""} ${command.keywords ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

export default function CommandPalette({
  commands,
  onClose,
}: {
  commands: PaletteCommand[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => commands.filter((command) => matches(command, query)), [commands, query]);
  const groups = useMemo(() => {
    const order: PaletteCommand["group"][] = ["Go to", "Actions", "Skills"];
    return order
      .map((group) => ({ group, items: visible.filter((command) => command.group === group) }))
      .filter((entry) => entry.items.length);
  }, [visible]);
  useModalPage();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(".palette-item.active")
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);
  const choose = (command: PaletteCommand) => {
    onClose();
    command.run();
  };
  return createPortal(
    <div
      className="overlay palette-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
          const forward = event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey);
          const backward = event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey);
          if (forward) {
            event.preventDefault();
            setIndex((value) => Math.min(value + 1, visible.length - 1));
          }
          if (backward) {
            event.preventDefault();
            setIndex((value) => Math.max(value - 1, 0));
          }
          if (event.key === "Enter" && visible[index]) {
            event.preventDefault();
            choose(visible[index]);
          }
        }}
      >
        <label className="palette-input">
          <Search size={18} />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Jump to a page, a skill, or an action"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={visible[index] ? `palette-${visible[index].id}` : undefined}
          />
        </label>
        <div className="palette-list" ref={list} id="palette-results" role="listbox">
          {groups.map(({ group, items }) => (
            <div key={group}>
              <div className="palette-group">{group}</div>
              {items.map((command) => {
                const active = visible[index]?.id === command.id;
                return (
                  <button
                    key={command.id}
                    id={`palette-${command.id}`}
                    role="option"
                    aria-selected={active}
                    className={`palette-item ${active ? "active" : ""}`}
                    tabIndex={-1}
                    onMouseEnter={() => setIndex(visible.indexOf(command))}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(command)}
                  >
                    {command.icon}
                    <span>
                      {command.label}
                      {command.hint ? <small>{command.hint}</small> : null}
                    </span>
                    <kbd aria-hidden="true">
                      <CornerDownLeft size={10} />
                    </kbd>
                  </button>
                );
              })}
            </div>
          ))}
          {!visible.length && <div className="palette-empty">Nothing matches “{query}”.</div>}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> to open
          </span>
          <span>
            <kbd>esc</kbd> to close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

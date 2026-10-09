import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";
const storageKey = "equip:theme";
const themes: Theme[] = ["light", "dark", "system"];

function stored(): Theme {
  try {
    const value = localStorage.getItem(storageKey) as Theme | null;
    return value && themes.includes(value) ? value : "system";
  } catch {
    return "system";
  }
}

/* The browser chrome follows the rail color so the window reads as one surface. */
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const rail = getComputedStyle(root).getPropertyValue("--olive").trim();
  if (meta && rail) meta.content = rail;
}

applyTheme(stored());

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(stored);
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => applyTheme("system");
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [theme]);
  const setTheme = (next: Theme) => {
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // Private browsing may block storage; the choice still applies for this session.
    }
    setThemeState(next);
  };
  return [theme, setTheme];
}

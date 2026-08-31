"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { Header } from "./Header";
import { Toast } from "./Toast";
import { ACCENT, THEMES, cssVars, type ThemeName } from "@/lib/theme";

interface Ui {
  theme: ThemeName;
  /// Fixed. Exposed on the context because most components colour against it, but it
  /// is no longer something the viewer can change.
  accent: string;
  t: (typeof THEMES)[ThemeName];
  setTheme: (t: ThemeName) => void;
  flash: (message: string) => void;
}

const UiContext = createContext<Ui | null>(null);

export function useUi(): Ui {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error("useUi must be used inside AppShell");
  return ctx;
}

const STORE_KEY = "walras.ui";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<ThemeName>("dark");
  const [toast, setToast] = useState<string | null>(null);

  // Remember the viewer's palette between visits. Storage can throw outright in a
  // locked-down browser, so every access is guarded and simply falls back to defaults.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { theme?: ThemeName };
      if (saved.theme === "dark" || saved.theme === "light") setTheme(saved.theme);
    } catch {
      /* no stored preference is a perfectly good state */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ theme }));
    } catch {
      /* refusing to persist is not worth surfacing */
    }
  }, [theme]);

  const flash = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((cur) => (cur === message ? null : cur)), 3400);
  }, []);

  const value = useMemo<Ui>(
    () => ({ theme, accent: ACCENT, t: THEMES[theme], setTheme, flash }),
    [theme, flash],
  );

  return (
    <UiContext.Provider value={value}>
      <div style={cssVars(theme)}>
        <div
          style={{
            minHeight: "100vh",
            background: "var(--bg)",
            color: "var(--fg)",
          }}
        >
          <Header />
          {children}
          {toast && <Toast message={toast} />}
        </div>
      </div>
    </UiContext.Provider>
  );
}

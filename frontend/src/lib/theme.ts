/// Design tokens, lifted from the Claude Design canvas. Two themes that are designed
/// rather than inverted — the light palette is warm paper, not a flipped dark ramp.
export type ThemeName = "dark" | "light";

export interface Tokens {
  bg: string;
  bgTint: string;
  panel: string;
  panel2: string;
  line: string;
  hatch: string;
  fg: string;
  bone: string;
  dim: string;
  faint: string;
}

export const THEMES: Record<ThemeName, Tokens> = {
  dark: {
    bg: "#0a0b09",
    bgTint: "rgba(10,11,9,0.92)",
    panel: "#0f110e",
    panel2: "#151813",
    line: "#1e211c",
    hatch: "#262a22",
    fg: "#f2f4ef",
    bone: "#f2f4ef",
    dim: "#8b9086",
    faint: "#5d6159",
  },
  light: {
    bg: "#f6f6f2",
    bgTint: "rgba(246,246,242,0.92)",
    panel: "#ffffff",
    panel2: "#ecece6",
    line: "#dcdcd4",
    hatch: "#c9cac1",
    fg: "#111310",
    bone: "#2a2d26",
    dim: "#5f6459",
    faint: "#9a9e92",
  },
};

/// The single accent. It marks the zeroForOne side and every actionable surface; the
/// opposing side uses `bone`, so neither direction reads as the "good" one the way
/// green/red would. Fixed rather than switchable — one loud colour is what makes the
/// residual stand out as the exception it is, and a palette picker undermines that.
export const ACCENT = "#c9f24d";

/// Text that sits on the accent. The accent range is deliberately bright, so this is
/// always the dark ground rather than a per-theme value.
export const ON_ACCENT = "#0a0b09";

export function cssVars(theme: ThemeName): React.CSSProperties {
  const t = THEMES[theme];
  return {
    "--bg": t.bg,
    "--bgTint": t.bgTint,
    "--panel": t.panel,
    "--panel2": t.panel2,
    "--line": t.line,
    "--hatch": t.hatch,
    "--fg": t.fg,
    "--bone": t.bone,
    "--dim": t.dim,
    "--faint": t.faint,
    "--acc": ACCENT,
    "--onAcc": ON_ACCENT,
    background: t.bg,
    colorScheme: theme,
  } as React.CSSProperties;
}

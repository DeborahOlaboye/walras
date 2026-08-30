"use client";

import { useUi } from "./AppShell";

export interface StatItem {
  k: string;
  v: string;
  sub?: string;
  fg?: string;
}

/// Hairline-separated cells. The 1px gap over a line-coloured ground is what draws the
/// rules between them, so the grid needs no per-cell borders.
export function StatGrid({
  items,
  columns,
  padding = "20px 22px",
  valueSize = 24,
}: {
  items: StatItem[];
  columns: number;
  padding?: string;
  valueSize?: number;
}) {
  const { t } = useUi();
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap: 1,
        background: t.line,
        border: "1px solid var(--line)",
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      {items.map((s) => (
        <div key={s.k} style={{ background: t.bg, padding }}>
          <div
            className="mono"
            style={{ fontSize: 11, color: t.faint, letterSpacing: "0.05em" }}
          >
            {s.k}
          </div>
          <div
            className="mono"
            style={{
              fontSize: valueSize,
              marginTop: 8,
              color: s.fg ?? t.fg,
            }}
          >
            {s.v}
          </div>
          {s.sub && (
            <div
              className="mono"
              style={{ fontSize: 11, color: t.faint, marginTop: 6 }}
            >
              {s.sub}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function Panel({
  children,
  padding = 0,
  style,
}: {
  children: React.ReactNode;
  padding?: number | string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: 16,
        overflow: "hidden",
        padding,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function StatusPill({
  label,
  fg,
  line,
  pulse = true,
}: {
  label: string;
  fg: string;
  line: string;
  pulse?: boolean;
}) {
  return (
    <div
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "5px 11px",
        borderRadius: 999,
        border: `1px solid ${line}`,
        color: fg,
        fontSize: 11,
        letterSpacing: "0.05em",
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: fg,
          animation: pulse ? "pulseDot 1.6s infinite" : undefined,
        }}
      />
      {label}
    </div>
  );
}

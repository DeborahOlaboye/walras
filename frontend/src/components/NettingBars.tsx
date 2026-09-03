"use client";

import { useUi } from "./AppShell";
import { f } from "@/lib/format";
import { SYM0, SYM1 } from "@/lib/config";

interface Props {
  netPct: number;
  res0Pct: number;
  res1Pct: number;
  matched: number;
  residualAmount: number;
  residualZeroForOne: boolean;
  e0?: number;
  e1?: number;
  /// Landing shows the escrowed totals alongside; the batch screen has them elsewhere.
  showTotals?: boolean;
  barHeight?: number;
}

/// The mechanism in one picture: two opposing bars, the hatched portion cancelling
/// internally, and only the solid overhang reaching pool liquidity.
export function NettingBars({
  netPct,
  res0Pct,
  res1Pct,
  matched,
  residualAmount,
  residualZeroForOne,
  e0,
  e1,
  showTotals = false,
  barHeight = 54,
}: Props) {
  const { t, accent } = useUi();
  const resFg = residualZeroForOne ? accent : t.bone;
  const cols = showTotals ? "128px 1fr 150px" : "118px 1fr";

  // With nothing in the group, the full layout renders as four zeros and two empty
  // bars, which reads as broken rather than empty. Say what will appear instead.
  const empty = (e0 ?? 0) + (e1 ?? 0) === 0 && matched === 0;
  if (empty) {
    return (
      <div
        style={{
          border: `1px dashed ${t.line}`,
          borderRadius: 12,
          padding: "28px 24px",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 15, color: t.dim, maxWidth: "52ch", margin: "0 auto" }}>
          Once orders arrive, this shows how much of the group trades directly between
          people, and how little of it reaches the pool.
        </div>
      </div>
    );
  }

  const hatch = {
    width: `${netPct}%`,
    background: `repeating-linear-gradient(135deg, ${t.hatch} 0 6px, transparent 6px 12px)`,
    borderRight: "1px solid var(--line)",
    transition: "width 0.6s cubic-bezier(0.2,0.7,0.2,1)",
  } as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Row
        cols={cols}
        label={`selling ${SYM0}`}
        labelColor={accent}
        total={showTotals ? f(e0 ?? 0, 2) : undefined}
      >
        <div
          style={{
            height: barHeight,
            display: "flex",
            borderRadius: 8,
            overflow: "hidden",
            background: t.panel2,
          }}
        >
          <div style={hatch} />
          <div
            style={{
              width: `${res0Pct}%`,
              background: accent,
              transition: "width 0.6s cubic-bezier(0.2,0.7,0.2,1)",
            }}
          />
        </div>
      </Row>

      <Row
        cols={cols}
        label={`selling ${SYM1}`}
        labelColor={t.bone}
        total={showTotals ? f(e1 ?? 0, 2) : undefined}
      >
        <div
          style={{
            height: barHeight,
            display: "flex",
            borderRadius: 8,
            overflow: "hidden",
            background: t.panel2,
          }}
        >
          <div style={hatch} />
          <div
            style={{
              width: `${res1Pct}%`,
              background: t.bone,
              transition: "width 0.6s cubic-bezier(0.2,0.7,0.2,1)",
            }}
          />
        </div>
      </Row>

      {/* A legend rather than labels pinned to the bar widths. Those were positioned
          by percentage, so at a high match rate the two ran into each other and read
          as one jammed-together string. This holds up at any ratio. */}
      <div style={{ display: "grid", gridTemplateColumns: cols, gap: 16 }}>
        <div />
        <div
          style={{
            marginTop: 6,
            borderTop: "1px solid var(--line)",
            paddingTop: 12,
            display: "flex",
            flexDirection: "column",
            gap: 9,
          }}
        >
          <LegendRow
            swatch={{
              background: `repeating-linear-gradient(135deg, ${t.hatch} 0 5px, transparent 5px 10px)`,
              border: `1px solid ${t.line}`,
            }}
            label="Matched with each other"
            value={f(matched, 2)}
            valueColor={t.fg}
          />
          <LegendRow
            swatch={{ background: resFg }}
            label="Left over, went to the pool"
            value={`${f(residualAmount, 2)} ${residualZeroForOne ? SYM0 : SYM1}`}
            valueColor={resFg}
          />
        </div>
        {showTotals && <div />}
      </div>
    </div>
  );
}

function LegendRow({
  swatch,
  label,
  value,
  valueColor,
}: {
  swatch: React.CSSProperties;
  label: string;
  value: string;
  valueColor: string;
}) {
  const { t } = useUi();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 14,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: 3,
            flex: "none",
            ...swatch,
          }}
        />
        <span style={{ fontSize: 14, color: t.dim }}>{label}</span>
      </span>
      <span className="mono" style={{ fontSize: 13.5, color: valueColor }}>
        {value}
      </span>
    </div>
  );
}

function Row({
  cols,
  label,
  labelColor,
  total,
  children,
}: {
  cols: string;
  label: string;
  labelColor: string;
  total?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: cols,
        alignItems: "center",
        gap: 16,
      }}
    >
      <div
        className="mono"
        style={{ fontSize: 12, color: labelColor, textAlign: "right" }}
      >
        {label}
      </div>
      {children}
      {total !== undefined && (
        <div className="mono" style={{ fontSize: 13 }}>
          {total}
        </div>
      )}
    </div>
  );
}

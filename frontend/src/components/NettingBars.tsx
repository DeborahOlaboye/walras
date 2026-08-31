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

      <div style={{ display: "grid", gridTemplateColumns: cols, gap: 16 }}>
        <div />
        <div style={{ position: "relative", height: 38 }}>
          <div
            className="mono"
            style={{
              position: "absolute",
              left: 0,
              width: `${netPct}%`,
              borderTop: "1px solid var(--line)",
              paddingTop: 8,
              fontSize: 11,
              color: t.dim,
              letterSpacing: "0.05em",
              whiteSpace: "nowrap",
              overflow: "hidden",
              transition: "width 0.6s",
            }}
          >
            MATCHED WITH EACH OTHER · {f(matched, 1)}
          </div>
          <div
            className="mono"
            style={{
              position: "absolute",
              left: `${netPct}%`,
              width: `${Math.max(res0Pct, res1Pct)}%`,
              borderTop: `1px solid ${resFg}`,
              paddingTop: 8,
              fontSize: 11,
              color: resFg,
              letterSpacing: "0.05em",
              whiteSpace: "nowrap",
              transition: "all 0.6s",
            }}
          >
            LEFT OVER, GOES TO THE POOL · {f(residualAmount, 1)}{" "}
            {residualZeroForOne ? SYM0 : SYM1}
          </div>
        </div>
        {showTotals && <div />}
      </div>
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

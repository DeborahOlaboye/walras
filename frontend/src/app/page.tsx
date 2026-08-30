"use client";

import Link from "next/link";

import { useUi } from "@/components/AppShell";
import { NettingBars } from "@/components/NettingBars";
import { Panel, StatGrid } from "@/components/Stat";
import { useBatchView } from "@/hooks/useBatchView";
import { SYM0, SYM1 } from "@/lib/config";
import { f, secondsLeft, shortAddress } from "@/lib/format";

const STEPS = [
  ["01", "Submit", "Input is escrowed immediately. No price is known yet, by design."],
  ["02", "Wait the window", "Twelve seconds shared with everyone else in the batch."],
  ["03", "Netting", "Opposing orders cancel at par; only the residual reaches the curve."],
  ["04", "Settle", "One clearing price for the batch. Surplus goes to LPs, not searchers."],
  ["05", "Claim", "Pull proceeds — or your whole input back if your limit priced you out."],
] as const;

export default function Landing() {
  const { t, accent } = useUi();
  const b = useBatchView();

  const cdFg = b.phase === "idle" ? t.faint : b.phase === "open" ? accent : t.fg;

  return (
    <div>
      <section
        style={{
          padding: "96px 30px 70px",
          maxWidth: 1500,
          display: "grid",
          gridTemplateColumns: "minmax(0,1.05fr) minmax(0,0.95fr)",
          gap: 60,
          alignItems: "start",
        }}
      >
        <div style={{ animation: "fadeUp 0.6s ease both" }}>
          <div
            className="mono"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 16px",
              border: "1px solid var(--line)",
              borderRadius: 999,
              fontSize: 12,
              color: t.dim,
            }}
          >
            <span style={{ color: accent }}>UHI10</span> Sealed batch auctions on
            Uniswap v4
          </div>

          <h1
            style={{
              margin: "30px 0 0",
              fontSize: 78,
              lineHeight: 0.94,
              letterSpacing: "-0.04em",
              fontWeight: 600,
              textWrap: "balance",
            }}
          >
            Nobody trades <span style={{ color: accent }}>first</span> here.
          </h1>

          <p
            style={{
              margin: "26px 0 0",
              maxWidth: "54ch",
              fontSize: 18,
              lineHeight: 1.55,
              color: t.dim,
              textWrap: "pretty",
            }}
          >
            Walras replaces continuous swapping with 12-second sealed windows. Every
            order in a window settles at one uniform clearing price, offsetting flow
            cancels before it reaches LP liquidity, and direct swaps through this pool
            revert. Ordering advantage stops existing.
          </p>

          <div style={{ display: "flex", gap: 12, marginTop: 36, flexWrap: "wrap" }}>
            <Link
              href="/batch"
              style={{
                padding: "15px 26px",
                borderRadius: 10,
                background: accent,
                color: "var(--onAcc)",
                fontWeight: 600,
                fontSize: 16,
              }}
            >
              Watch the live batch
            </Link>
            <Link
              href="/trade"
              style={{
                padding: "15px 26px",
                borderRadius: 10,
                border: `1px solid ${accent}`,
                color: accent,
                fontWeight: 600,
                fontSize: 16,
              }}
            >
              Submit an order
            </Link>
          </div>

          <div style={{ display: "flex", gap: 40, marginTop: 52, flexWrap: "wrap" }}>
            {[
              { k: "BATCH WINDOW", v: `${Number(b.batchDuration)}s` },
              { k: "ORDERS PER BATCH", v: `≤ ${b.maxOrders}` },
              { k: "SANDWICHABLE SURFACE", v: "0" },
            ].map((s) => (
              <div key={s.k}>
                <div className="mono" style={{ fontSize: 27 }}>
                  {s.v}
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: t.faint,
                    letterSpacing: "0.06em",
                    marginTop: 5,
                  }}
                >
                  {s.k}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Live window card */}
        <Panel style={{ background: t.panel, animation: "fadeUp 0.6s 0.1s ease both" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "15px 20px",
              borderBottom: "1px solid var(--line)",
            }}
          >
            <div
              className="mono"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                fontSize: 11.5,
                letterSpacing: "0.06em",
                color: t.dim,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: cdFg,
                  animation: "pulseDot 1.6s infinite",
                }}
              />
              {b.statusLabel} · BATCH #{String(b.currentId)}
            </div>
            <Link href="/batch" className="mono" style={{ fontSize: 11 }}>
              OPEN →
            </Link>
          </div>

          <div
            style={{
              padding: "26px 24px 20px",
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
            }}
          >
            <div>
              <div
                className="mono"
                style={{ fontSize: 11, color: t.faint, letterSpacing: "0.06em" }}
              >
                {b.phase === "idle"
                  ? "NO TIMER RUNNING"
                  : b.phase === "open"
                    ? "WINDOW CLOSES IN"
                    : "WINDOW CLOSED"}
              </div>
              <div
                className="mono"
                style={{
                  fontSize: b.phase === "idle" ? 34 : 62,
                  lineHeight: 1.1,
                  color: cdFg,
                }}
              >
                {b.phase === "idle" ? "IDLE" : secondsLeft(b.remainMs)}
              </div>
              <div
                className="mono"
                style={{ fontSize: 11, color: t.faint, marginTop: 4 }}
              >
                {b.phase === "idle"
                  ? "opens with the first order"
                  : b.phase === "open"
                    ? "uniform price for everyone inside"
                    : "awaiting settlement trigger"}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div
                className="mono"
                style={{ fontSize: 11, color: t.faint, letterSpacing: "0.06em" }}
              >
                ORDERS
              </div>
              <div className="mono" style={{ fontSize: 30 }}>
                {b.count}
                <span style={{ fontSize: 15, color: t.faint }}>/{b.maxOrders}</span>
              </div>
            </div>
          </div>

          <div style={{ height: 3, background: t.panel2, margin: "0 24px" }}>
            <div
              style={{
                height: 3,
                width: `${b.pct}%`,
                background: cdFg,
                transition: "width 0.1s linear",
              }}
            />
          </div>

          <div
            className="mono"
            style={{
              padding: "18px 24px 8px",
              display: "flex",
              justifyContent: "space-between",
              fontSize: 12,
            }}
          >
            <span style={{ color: accent }}>
              {f(b.e0, 2)} {SYM0} →
            </span>
            <span style={{ color: t.bone }}>
              ← {f(b.e1, 2)} {SYM1}
            </span>
          </div>

          <div style={{ maxHeight: 232, overflow: "hidden" }}>
            {b.orders.length === 0 ? (
              <div
                style={{
                  padding: "24px",
                  fontSize: 14,
                  color: t.dim,
                  borderTop: `1px solid ${t.panel2}`,
                }}
              >
                No orders in this window yet.
              </div>
            ) : (
              [...b.orders]
                .reverse()
                .slice(0, 4)
                .map((o, i) => (
                  <div
                    key={`${o.owner}-${i}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "11px 24px",
                      borderTop: `1px solid ${t.panel2}`,
                      animation: "rowIn 0.35s ease both",
                    }}
                  >
                    <span
                      className="mono"
                      style={{ fontSize: 11.5, color: t.dim }}
                    >
                      {shortAddress(o.owner)}
                    </span>
                    <span
                      className="mono"
                      style={{ fontSize: 12, color: o.zeroForOne ? accent : t.bone }}
                    >
                      {f(Number(o.amountIn) / 1e18, 0)}{" "}
                      {o.zeroForOne ? `${SYM0} → ${SYM1}` : `${SYM1} → ${SYM0}`}
                    </span>
                  </div>
                ))
            )}
          </div>
        </Panel>
      </section>

      {/* Netting explainer */}
      <section style={{ padding: "30px 30px 80px", maxWidth: 1500 }}>
        <Panel padding="34px 34px 40px">
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
              gap: 30,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div
                className="mono"
                style={{ fontSize: 11.5, color: accent, letterSpacing: "0.08em" }}
              >
                THE PART THAT MATTERS
              </div>
              <h2
                style={{
                  margin: "12px 0 0",
                  fontSize: 40,
                  letterSpacing: "-0.03em",
                  fontWeight: 600,
                }}
              >
                Most flow never reaches the curve.
              </h2>
            </div>
            <p
              style={{
                margin: 0,
                maxWidth: "46ch",
                fontSize: 16,
                lineHeight: 1.5,
                color: t.dim,
                textWrap: "pretty",
              }}
            >
              Opposite directions inside a window cancel each other at par. Only the
              unmatched residual is swapped against pool liquidity — so there is barely
              any price impact left to trade ahead of.
            </p>
          </div>

          <div style={{ marginTop: 42 }}>
            <NettingBars
              netPct={b.netPct}
              res0Pct={b.res0Pct}
              res1Pct={b.res1Pct}
              matched={b.matched}
              residualAmount={b.residualAmount}
              residualZeroForOne={b.residualZeroForOne}
              e0={b.e0}
              e1={b.e1}
              showTotals
              barHeight={58}
            />
          </div>

          <div style={{ marginTop: 34 }}>
            <StatGrid
              columns={4}
              items={[
                {
                  k: "FLOW NETTED THIS WINDOW",
                  v:
                    b.e0 + b.e1 > 0
                      ? `${f(((b.matched * 2) / Math.max(b.e0 + b.e1, 1e-9)) * 100, 1)}%`
                      : "0%",
                  fg: accent,
                },
                {
                  k: "POOL MID",
                  v: b.price ? f(b.price, 5) : "—",
                },
                { k: "ORDERS IN WINDOW", v: String(b.count) },
                { k: "SURPLUS TO LPS, NOT BOTS", v: "100%" },
              ]}
            />
          </div>
        </Panel>
      </section>

      {/* How it works */}
      <section style={{ padding: "0 30px 90px", maxWidth: 1500 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(5, minmax(0,1fr))",
            gap: 1,
            background: t.line,
            border: "1px solid var(--line)",
            borderRadius: 16,
            overflow: "hidden",
          }}
        >
          {STEPS.map(([n, title, d]) => (
            <div
              key={n}
              style={{
                background: t.bg,
                padding: "26px 22px 30px",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <div className="mono" style={{ fontSize: 11, color: accent }}>
                {n}
              </div>
              <div
                style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.02em" }}
              >
                {title}
              </div>
              <div
                style={{
                  fontSize: 14,
                  lineHeight: 1.5,
                  color: t.dim,
                  textWrap: "pretty",
                }}
              >
                {d}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Exclusivity teaser */}
      <section style={{ padding: "0 30px 110px", maxWidth: 1500 }}>
        <Panel
          padding={40}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0,1fr) auto",
            gap: 40,
            alignItems: "center",
          }}
        >
          <div>
            <h2
              style={{
                margin: 0,
                fontSize: 34,
                letterSpacing: "-0.03em",
                fontWeight: 600,
              }}
            >
              There is no side door.
            </h2>
            <p
              style={{
                margin: "14px 0 0",
                maxWidth: "60ch",
                fontSize: 16,
                lineHeight: 1.55,
                color: t.dim,
                textWrap: "pretty",
              }}
            >
              Try to route a normal swap through this pool and{" "}
              <span className="mono" style={{ fontSize: 14, color: accent }}>
                beforeSwap
              </span>{" "}
              reverts it. Not a setting, not opt-in protection — the pool has no
              continuous execution path at all.
            </p>
          </div>
          <Link
            href="/proof"
            style={{
              padding: "15px 26px",
              borderRadius: 10,
              border: `1px solid ${accent}`,
              color: accent,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            See it revert →
          </Link>
        </Panel>
      </section>
    </div>
  );
}

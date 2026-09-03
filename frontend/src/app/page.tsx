"use client";

import Link from "next/link";

import { useUi } from "@/components/AppShell";
import { NettingBars } from "@/components/NettingBars";
import { Panel, StatGrid } from "@/components/Stat";
import { useBatchView } from "@/hooks/useBatchView";
import { SYM0, SYM1 } from "@/lib/config";
import { f, secondsLeft, shortAddress } from "@/lib/format";

const STEPS = [
  [
    "01",
    "You place an order",
    "Your tokens are held straight away. Nobody knows the price yet — that is the whole point.",
  ],
  [
    "02",
    "You wait up to a minute",
    "Everyone who orders in that time is grouped together with you.",
  ],
  [
    "03",
    "Opposite orders cancel out",
    "If someone wants to buy what you are selling, you trade with them directly instead of with the pool.",
  ],
  [
    "04",
    "Everyone gets one price",
    "The whole group trades at a single price. There is no first or last, so nobody can jump ahead of you.",
  ],
  [
    "05",
    "You collect",
    "Take your tokens. If the price was worse than your limit, you get your original tokens back instead.",
  ],
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
            <span style={{ color: accent }}>UHI10</span> A Uniswap v4 pool that trades in
            groups
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
            Everyone gets the <span style={{ color: accent }}>same price</span>.
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
            On a normal exchange, bots watch for your trade and jump in front of it to
            take a cut. Walras stops that by collecting orders for a minute and trading them
            all at once, at a single price. Nobody goes first, so there is nothing to
            jump in front of.
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
              See a live group
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
              Place an order
            </Link>
          </div>

          <div style={{ display: "flex", gap: 40, marginTop: 52, flexWrap: "wrap" }}>
            {[
              { k: "ORDERS ARE GROUPED EVERY", v: `${Number(b.batchDuration)}s` },
              { k: "ORDERS PER GROUP", v: `up to ${b.maxOrders}` },
              { k: "WAYS TO JUMP THE QUEUE", v: "0" },
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
              {b.statusLabel} · GROUP #{String(b.currentId)}
            </div>
            <Link href="/batch" className="mono" style={{ fontSize: 11 }}>
              OPEN →
            </Link>
          </div>

          {/* With no group running, the live layout is a countdown reading "WAITING",
              a 0/64 counter and two 0.00 totals — four ways of saying nothing is
              happening. One statement and a way in is more use. */}
          {b.phase === "idle" ? (
            <div
              style={{
                padding: "34px 24px 32px",
                display: "flex",
                flexDirection: "column",
                gap: 16,
                alignItems: "flex-start",
              }}
            >
              <div
                style={{
                  fontSize: 17,
                  lineHeight: 1.5,
                  color: t.dim,
                  textWrap: "pretty",
                }}
              >
                No group is collecting right now. The next order placed starts one, and
                everyone who joins within {Number(b.batchDuration)} seconds trades
                alongside it at a single price.
              </div>
              <Link
                href="/trade"
                style={{
                  padding: "12px 20px",
                  borderRadius: 10,
                  background: accent,
                  color: "var(--onAcc)",
                  fontWeight: 600,
                }}
              >
                Start one
              </Link>
            </div>
          ) : (
            <>
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
                    {b.phase === "open" ? "THIS GROUP TRADES IN" : "TIME IS UP"}
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 62, lineHeight: 1.1, color: cdFg }}
                  >
                    {secondsLeft(b.remainMs)}
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 11, color: t.faint, marginTop: 4 }}
                  >
                    {b.phase === "open"
                      ? "one price for everyone in it"
                      : "waiting for someone to close it"}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div
                    className="mono"
                    style={{ fontSize: 11, color: t.faint, letterSpacing: "0.06em" }}
                  >
                    ORDERS SO FAR
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
                {[...b.orders]
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
                ))}
              </div>
            </>
          )}
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
                Most trades never touch the pool.
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
              If you are selling WDA and someone else in the same group is buying
              it, the two of you simply trade with each other. Only whatever is left
              over after that goes to the pool. Small trades move the price less, and a
              price that barely moves is not worth attacking.
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
                  k: "MATCHED WITH EACH OTHER",
                  v:
                    b.e0 + b.e1 > 0
                      ? `${f(((b.matched * 2) / Math.max(b.e0 + b.e1, 1e-9)) * 100, 1)}%`
                      : "0%",
                  fg: accent,
                },
                {
                  k: "CURRENT POOL PRICE",
                  v: b.price ? f(b.price, 5) : "—",
                },
                { k: "ORDERS RIGHT NOW", v: String(b.count) },
                { k: "EXTRA VALUE KEPT FROM BOTS", v: "100%" },
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
              There is no way around it.
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
              Try to trade through this pool the normal way and it is{" "}
              <span className="mono" style={{ fontSize: 14, color: accent }}>
                beforeSwap
              </span>{" "}
              refused. This is not a setting anyone can switch off — the pool simply has no way to trade outside a group.
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
            Watch it get refused →
          </Link>
        </Panel>
      </section>
    </div>
  );
}

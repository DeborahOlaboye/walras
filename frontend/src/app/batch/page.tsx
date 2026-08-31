"use client";

import Link from "next/link";

import { useUi } from "@/components/AppShell";
import { NettingBars } from "@/components/NettingBars";
import { Panel, StatGrid, StatusPill } from "@/components/Stat";
import { useActions } from "@/hooks/useActions";
import { useBatchView } from "@/hooks/useBatchView";
import { useSettled } from "@/hooks/useSettled";
import { useWallet } from "@/hooks/useWallet";
import { SYM0, SYM1 } from "@/lib/config";
import { f, fromWei, secondsLeft, shortAddress, sqrtPriceToPrice } from "@/lib/format";
import { eligibleVolume, nettingSplit, residual } from "@/lib/netting";

export default function BatchScreen() {
  const { t, accent } = useUi();
  const b = useBatchView();
  const { address } = useWallet();
  const { poke, pending } = useActions(b.refresh);
  const { batches } = useSettled();

  // A window is open for a minute and the pool is idle the rest of the time. Rather
  // than show an empty shell, fall back to the last completed group — clearly marked
  // as past, never dressed up as live — so the screen always demonstrates something.
  const last = b.phase === "idle" ? batches.find((x) => !x.failed) : undefined;
  const replay = !!last;

  const lastView = last
    ? (() => {
        const { eligible0, eligible1 } = eligibleVolume(
          last.orders,
          last.clearingSqrtPriceX96,
          0n,
        );
        const split = nettingSplit(eligible0, eligible1, last.clearingSqrtPriceX96);
        const res = residual(eligible0, eligible1, last.clearingSqrtPriceX96);
        const sum = (z: boolean) =>
          fromWei(
            last.orders
              .filter((o) => o.zeroForOne === z)
              .reduce((s, o) => s + o.amountIn, 0n),
          );
        return {
          e0: sum(true),
          e1: sum(false),
          netPct: split.netPct,
          res0Pct: split.res0Pct,
          res1Pct: split.res1Pct,
          matched: fromWei(split.matched),
          residualAmount: fromWei(res.amount),
          residualZeroForOne: res.zeroForOne,
          price: sqrtPriceToPrice(last.clearingSqrtPriceX96),
        };
      })()
    : null;

  const view = replay && lastView ? lastView : b;
  const orders = replay && last ? last.orders : b.orders;
  const groupNo = replay && last ? String(last.id) : String(b.currentId);

  const liveFg =
    b.phase === "idle" ? t.faint : b.phase === "open" ? accent : t.fg;
  const matchedPct =
    view.e0 + view.e1 > 0
      ? (view.matched * 2) / Math.max(view.e0 + view.e1, 1e-9) * 100
      : 0;

  /// One sentence under the clock, answering "what am I looking at" without
  /// assuming the reader knows what a batch auction is.
  const headline = replay
    ? "This group has already traded. Every order in it got the single price below."
    : b.phase === "open"
      ? `Anyone who places an order in the next ${secondsLeft(b.remainMs)} joins this group and gets exactly the same price as everyone else in it.`
      : b.phase === "elapsed"
        ? "The minute is up. This group is ready to trade — someone just has to close it."
        : `Nothing is collecting right now. The next order placed starts a new ${Number(b.batchDuration)}-second group.`;

  return (
    <div style={{ padding: "34px 30px 90px", maxWidth: 1500 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) 360px",
          gap: 26,
          alignItems: "start",
        }}
      >
        <div
          style={{ display: "flex", flexDirection: "column", gap: 26, minWidth: 0 }}
        >
          {/* The clock is the whole point of this screen, so it leads rather than
              sitting in a corner competing with three other panels. */}
          <Panel>
            <div style={{ padding: "30px 30px 26px" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.02em" }}>
                  Group #{groupNo}
                </div>
                <StatusPill
                  label={replay ? "ALREADY TRADED" : b.statusLabel}
                  fg={replay ? t.dim : liveFg}
                  line={b.phase === "idle" && !replay ? t.line : replay ? t.line : liveFg}
                  pulse={!replay && b.phase !== "idle"}
                />
              </div>

              <div
                style={{
                  marginTop: 18,
                  display: "flex",
                  alignItems: "baseline",
                  gap: 18,
                  flexWrap: "wrap",
                }}
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 72,
                    lineHeight: 1,
                    color: replay ? accent : liveFg,
                  }}
                >
                  {replay && lastView
                    ? f(lastView.price, 5)
                    : b.phase === "idle"
                      ? "—"
                      : secondsLeft(b.remainMs)}
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 12, color: t.faint, letterSpacing: "0.06em" }}
                >
                  {replay
                    ? `THE ONE PRICE THEY ALL GOT · ${SYM1} PER ${SYM0}`
                    : b.phase === "open"
                      ? "UNTIL THIS GROUP TRADES"
                      : b.phase === "elapsed"
                        ? "READY TO TRADE"
                        : "NO GROUP OPEN"}
                </div>
              </div>

              <div
                style={{
                  marginTop: 14,
                  fontSize: 16,
                  lineHeight: 1.5,
                  color: t.dim,
                  maxWidth: "64ch",
                  textWrap: "pretty",
                }}
              >
                {headline}
              </div>

              <div
                className="mono"
                style={{ marginTop: 14, fontSize: 12, color: t.faint }}
              >
                {orders.length} {orders.length === 1 ? "order" : "orders"}
                {!replay && ` · room for ${b.maxOrders}`}
              </div>
            </div>

            <div style={{ height: 4, background: t.panel2 }}>
              <div
                style={{
                  height: 4,
                  width: replay ? "100%" : `${b.pct}%`,
                  background: replay ? t.line : liveFg,
                  transition: "width 0.1s linear",
                }}
              />
            </div>
          </Panel>

          {/* Amounts live on the bars themselves rather than in a separate block
              above, which previously showed the same two numbers twice. */}
          <Panel padding="28px 30px 32px">
            <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.02em" }}>
              {replay ? "How these orders matched up" : "How these orders will match up"}
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 14.5,
                color: t.dim,
                maxWidth: "70ch",
                textWrap: "pretty",
              }}
            >
              People selling {SYM0} trade directly with people selling {SYM1}, as far as
              the two sides go. Only the difference between them reaches the pool.
            </div>

            <div style={{ marginTop: 26 }}>
              <NettingBars
                netPct={view.netPct}
                res0Pct={view.res0Pct}
                res1Pct={view.res1Pct}
                matched={view.matched}
                residualAmount={view.residualAmount}
                residualZeroForOne={view.residualZeroForOne}
                e0={view.e0}
                e1={view.e1}
                showTotals
              />
            </div>

            <div style={{ marginTop: 30 }}>
              <StatGrid
                columns={3}
                padding="18px 20px"
                valueSize={21}
                items={[
                  {
                    k: "TRADED WITH EACH OTHER",
                    v: `${f(matchedPct, 1)}%`,
                    fg: accent,
                  },
                  {
                    k: "LEFT OVER FOR THE POOL",
                    v: orders.length ? f(view.residualAmount, 2) : "—",
                  },
                  {
                    k: replay ? "PRICE THEY GOT" : "POOL PRICE NOW",
                    v: view.price ? f(view.price, 5) : "—",
                  },
                ]}
              />
            </div>

            {b.phase === "elapsed" && !replay && (
              <div
                style={{
                  marginTop: 24,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 20,
                  border: `1px solid ${accent}`,
                  borderRadius: 12,
                  padding: "18px 20px",
                  flexWrap: "wrap",
                }}
              >
                <div
                  style={{
                    fontSize: 14.5,
                    color: t.dim,
                    textWrap: "pretty",
                    maxWidth: "56ch",
                  }}
                >
                  Anyone can close this group — you do not have to have an order in it.
                  Whoever does keeps {b.bountyBips / 100}% of what the group saved, for
                  covering the gas.
                </div>
                <button
                  onClick={() => poke()}
                  disabled={!address || pending !== null}
                  style={{
                    flex: "none",
                    padding: "13px 22px",
                    borderRadius: 10,
                    background: address ? accent : t.panel2,
                    color: address ? "var(--onAcc)" : t.faint,
                    fontWeight: 600,
                  }}
                >
                  {pending === "Settle"
                    ? "Closing…"
                    : address
                      ? "Close and trade it"
                      : "Connect a wallet to close it"}
                </button>
              </div>
            )}
          </Panel>
        </div>

        <Panel style={{ position: "sticky", top: 96 }}>
          <div
            style={{
              padding: "16px 20px",
              borderBottom: "1px solid var(--line)",
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              {replay ? "Who was in it" : "Who is in this group"}
            </div>
            <div style={{ fontSize: 13, color: t.faint, marginTop: 3 }}>
              {replay
                ? "All of them traded at one price"
                : "All of them will get one price"}
            </div>
          </div>

          {orders.length > 0 ? (
            <div style={{ maxHeight: 560, overflowY: "auto" }}>
              {[...orders].reverse().map((o, i) => {
                const mine =
                  address && o.owner.toLowerCase() === address.toLowerCase();
                return (
                  <div
                    key={`${o.owner}-${i}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "3px 1fr auto",
                      alignItems: "center",
                      gap: 12,
                      padding: "14px 20px",
                      borderBottom: `1px solid ${t.panel2}`,
                      animation: "rowIn 0.35s ease both",
                      background: mine ? t.panel2 : "transparent",
                    }}
                  >
                    <div
                      style={{
                        width: 3,
                        height: 28,
                        borderRadius: 2,
                        background: o.zeroForOne ? accent : t.bone,
                      }}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14 }}>
                        {mine ? "You" : shortAddress(o.owner)}
                      </div>
                      <div
                        className="mono"
                        style={{
                          fontSize: 11,
                          color: o.zeroForOne ? accent : t.bone,
                          marginTop: 3,
                        }}
                      >
                        selling {o.zeroForOne ? SYM0 : SYM1}
                      </div>
                    </div>
                    <div className="mono" style={{ fontSize: 14, textAlign: "right" }}>
                      {f(fromWei(o.amountIn), 2)}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div
              style={{
                padding: "40px 22px",
                display: "flex",
                flexDirection: "column",
                gap: 14,
                alignItems: "flex-start",
              }}
            >
              <div style={{ fontSize: 15, color: t.dim, textWrap: "pretty" }}>
                Nobody has placed an order yet. The first one starts the clock, and
                everyone who joins in the {Number(b.batchDuration)} seconds after
                trades alongside them.
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
                Place the first order
              </Link>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

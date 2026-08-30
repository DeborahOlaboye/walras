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

  // A window lives twelve seconds; the pool is idle the rest of the time. Rather than
  // show an empty shell, fall back to the last completed window — clearly marked as
  // history, never dressed up as live — so the screen always demonstrates the
  // mechanism instead of a row of zeros.
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
        return {
          e0: fromWei(last.orders.filter((o) => o.zeroForOne).reduce((s, o) => s + o.amountIn, 0n)),
          e1: fromWei(last.orders.filter((o) => !o.zeroForOne).reduce((s, o) => s + o.amountIn, 0n)),
          n0: last.orders.filter((o) => o.zeroForOne).length,
          n1: last.orders.filter((o) => !o.zeroForOne).length,
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

  // Everything below reads from one of the two sources, chosen once here.
  const view = replay && lastView ? lastView : b;
  const orders = replay && last ? last.orders : b.orders;
  const batchLabel = replay && last ? String(last.id) : String(b.currentId);

  const cdFg = b.phase === "idle" ? t.faint : b.phase === "open" ? accent : t.fg;
  const statusFg = replay ? t.dim : cdFg;

  return (
    <div style={{ padding: "34px 30px 90px", maxWidth: 1500 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) 380px",
          gap: 26,
          alignItems: "start",
        }}
      >
        <div
          style={{ display: "flex", flexDirection: "column", gap: 26, minWidth: 0 }}
        >
          {/* Window header */}
          <Panel>
            <div
              style={{
                padding: "30px 30px 24px",
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 30,
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div
                    style={{
                      fontSize: 30,
                      fontWeight: 600,
                      letterSpacing: "-0.03em",
                    }}
                  >
                    Batch #{batchLabel}
                  </div>
                  <StatusPill
                    label={replay ? "LAST WINDOW · SETTLED" : b.statusLabel}
                    fg={statusFg}
                    line={b.phase === "idle" ? t.line : statusFg}
                    pulse={!replay}
                  />
                </div>
                <div
                  style={{
                    marginTop: 10,
                    fontSize: 16,
                    color: t.dim,
                    maxWidth: "62ch",
                    textWrap: "pretty",
                  }}
                >
                  {replay
                    ? "No window is open right now. This is the last one that settled — every order in it filled at the single price below."
                    : b.statusNote}
                </div>
              </div>
              <div style={{ textAlign: "right", flex: "none" }}>
                <div
                  className="mono"
                  style={{ fontSize: 11, color: t.faint, letterSpacing: "0.06em" }}
                >
                  {replay
                    ? "CLEARED AT"
                    : b.phase === "idle"
                      ? "NO TIMER RUNNING"
                      : b.phase === "open"
                        ? "WINDOW CLOSES IN"
                        : "WINDOW CLOSED"}
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: replay ? 44 : b.phase === "idle" ? 38 : 68,
                    lineHeight: 1.05,
                    color: replay ? accent : cdFg,
                  }}
                >
                  {replay && lastView
                    ? f(lastView.price, 5)
                    : b.phase === "idle"
                      ? "IDLE"
                      : secondsLeft(b.remainMs)}
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 12, color: t.dim, marginTop: 4 }}
                >
                  {replay
                    ? `${orders.length} orders · one price for all of them`
                    : `${b.count} / ${b.maxOrders} orders`}
                </div>
              </div>
            </div>

            <div style={{ height: 4, background: t.panel2 }}>
              <div
                style={{
                  height: 4,
                  width: replay ? "100%" : `${b.pct}%`,
                  background: replay ? t.line : cdFg,
                  transition: "width 0.1s linear",
                }}
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
              <div
                style={{
                  padding: "24px 30px",
                  borderRight: "1px solid var(--line)",
                }}
              >
                <div
                  className="mono"
                  style={{ fontSize: 11, letterSpacing: "0.06em", color: accent }}
                >
                  ESCROWED · {SYM0} → {SYM1}
                </div>
                <div className="mono" style={{ fontSize: 34, marginTop: 8 }}>
                  {f(view.e0, 2)}
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 12, color: t.faint, marginTop: 4 }}
                >
                  {view.n0} orders · zeroForOne
                </div>
              </div>
              <div style={{ padding: "24px 30px", textAlign: "right" }}>
                <div
                  className="mono"
                  style={{ fontSize: 11, letterSpacing: "0.06em", color: t.bone }}
                >
                  ESCROWED · {SYM1} → {SYM0}
                </div>
                <div className="mono" style={{ fontSize: 34, marginTop: 8 }}>
                  {f(view.e1, 2)}
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 12, color: t.faint, marginTop: 4 }}
                >
                  {view.n1} orders · oneForZero
                </div>
              </div>
            </div>
          </Panel>

          {/* Live netting */}
          <Panel padding="28px 30px 32px">
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 24,
                flexWrap: "wrap",
              }}
            >
              <div
                style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.02em" }}
              >
                {replay ? "How that window netted" : "Netting, live"}
              </div>
              <div style={{ fontSize: 14.5, color: t.dim }}>
                Opposite directions cancel at par. Only the residual touches pool
                liquidity.
              </div>
            </div>

            <div style={{ marginTop: 26 }}>
              <NettingBars
                netPct={view.netPct}
                res0Pct={view.res0Pct}
                res1Pct={view.res1Pct}
                matched={view.matched}
                residualAmount={view.residualAmount}
                residualZeroForOne={view.residualZeroForOne}
              />
            </div>

            <div style={{ marginTop: 30 }}>
              <StatGrid
                columns={3}
                padding="18px 20px"
                valueSize={21}
                items={[
                  {
                    k: "NETTED / TOTAL FLOW",
                    v:
                      view.e0 + view.e1 > 0
                        ? `${f(((view.matched * 2) / Math.max(view.e0 + view.e1, 1e-9)) * 100, 1)}%`
                        : "0%",
                    fg: accent,
                  },
                  {
                    k: "RESIDUAL TO CURVE",
                    v: orders.length ? `${f(view.residualAmount, 2)}` : "—",
                  },
                  {
                    k: replay ? "CLEARED AT P*" : "POOL MID NOW",
                    v: view.price ? f(view.price, 5) : "—",
                  },
                ]}
              />
            </div>

            {b.phase === "elapsed" && (
              <div
                style={{
                  marginTop: 24,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 24,
                  border: `1px solid ${accent}`,
                  borderRadius: 12,
                  padding: "18px 20px",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ fontSize: 14.5, color: t.dim, textWrap: "pretty" }}>
                  Window elapsed. Settlement is permissionless — trigger it yourself
                  and take the {b.bountyBips / 100}% bounty on the surplus.
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
                    ? "Settling…"
                    : address
                      ? "Settle this batch"
                      : "Connect to settle"}
                </button>
              </div>
            )}
          </Panel>
        </div>

        {/* Orders in this window */}
        <Panel style={{ position: "sticky", top: 96 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "16px 20px",
              borderBottom: "1px solid var(--line)",
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              {replay ? "Orders in that window" : "Orders in this window"}
            </div>
            <div className="mono" style={{ fontSize: 11, color: t.faint }}>
              {replay ? "ALL ONE PRICE" : "SHARED FATE"}
            </div>
          </div>

          {orders.length > 0 ? (
            <div style={{ maxHeight: 620, overflowY: "auto" }}>
              {[...orders].reverse().map((o, i) => {
                const mine =
                  address && o.owner.toLowerCase() === address.toLowerCase();
                const unbounded =
                  o.sqrtPriceLimitX96 < 4295128740n ||
                  o.sqrtPriceLimitX96 >
                    1461446703485210103287273052203988822378723970000n;
                return (
                  <div
                    key={`${o.owner}-${i}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "3px 1fr auto",
                      alignItems: "center",
                      gap: 12,
                      padding: "13px 20px",
                      borderBottom: `1px solid ${t.panel2}`,
                      animation: "rowIn 0.35s ease both",
                      background: mine ? t.panel2 : "transparent",
                    }}
                  >
                    <div
                      style={{
                        width: 3,
                        height: 26,
                        borderRadius: 2,
                        background: o.zeroForOne ? accent : t.bone,
                      }}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div className="mono" style={{ fontSize: 12, color: t.dim }}>
                        {mine ? "you · " : ""}
                        {shortAddress(o.owner)}
                      </div>
                      <div
                        className="mono"
                        style={{
                          fontSize: 11,
                          color: o.zeroForOne ? accent : t.bone,
                          marginTop: 3,
                        }}
                      >
                        {o.zeroForOne
                          ? `zeroForOne · ${SYM0} → ${SYM1}`
                          : `oneForZero · ${SYM1} → ${SYM0}`}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div className="mono" style={{ fontSize: 13.5 }}>
                        {f(Number(o.amountIn) / 1e18, 2)}{" "}
                        {o.zeroForOne ? SYM0 : SYM1}
                      </div>
                      <div
                        className="mono"
                        style={{ fontSize: 10.5, color: t.faint, marginTop: 3 }}
                      >
                        {unbounded
                          ? "unbounded"
                          : `limit ${f(sqrtPriceToPrice(o.sqrtPriceLimitX96), 4)}`}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div
              style={{
                padding: "46px 24px",
                display: "flex",
                flexDirection: "column",
                gap: 14,
                alignItems: "flex-start",
              }}
            >
              <div
                className="mono"
                style={{ fontSize: 11, color: t.faint, letterSpacing: "0.06em" }}
              >
                NO TIMER RUNNING
              </div>
              <div style={{ fontSize: 15, color: t.dim, textWrap: "pretty" }}>
                An idle pool runs no clock. The {Number(b.batchDuration)}-second
                window opens with the first order — yours or anyone&apos;s.
              </div>
              <Link
                href="/trade"
                style={{
                  marginTop: 4,
                  padding: "12px 20px",
                  borderRadius: 10,
                  background: accent,
                  color: "var(--onAcc)",
                  fontWeight: 600,
                }}
              >
                Open the window
              </Link>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

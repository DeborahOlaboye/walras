"use client";

import Link from "next/link";

import { useUi } from "@/components/AppShell";
import { NettingBars } from "@/components/NettingBars";
import { Panel, StatGrid, StatusPill } from "@/components/Stat";
import { useActions } from "@/hooks/useActions";
import { useBatchView } from "@/hooks/useBatchView";
import { useWallet } from "@/hooks/useWallet";
import { SYM0, SYM1 } from "@/lib/config";
import { f, secondsLeft, shortAddress, sqrtPriceToPrice } from "@/lib/format";

export default function BatchScreen() {
  const { t, accent } = useUi();
  const b = useBatchView();
  const { address } = useWallet();
  const { poke, pending } = useActions(b.refresh);

  const cdFg = b.phase === "idle" ? t.faint : b.phase === "open" ? accent : t.fg;
  const statusFg = cdFg;

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
                    Batch #{String(b.currentId)}
                  </div>
                  <StatusPill
                    label={b.statusLabel}
                    fg={statusFg}
                    line={b.phase === "idle" ? t.line : statusFg}
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
                  {b.statusNote}
                </div>
              </div>
              <div style={{ textAlign: "right", flex: "none" }}>
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
                    fontSize: b.phase === "idle" ? 38 : 68,
                    lineHeight: 1.05,
                    color: cdFg,
                  }}
                >
                  {b.phase === "idle" ? "IDLE" : secondsLeft(b.remainMs)}
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 12, color: t.dim, marginTop: 4 }}
                >
                  {b.count} / {b.maxOrders} orders
                </div>
              </div>
            </div>

            <div style={{ height: 4, background: t.panel2 }}>
              <div
                style={{
                  height: 4,
                  width: `${b.pct}%`,
                  background: cdFg,
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
                  {f(b.e0, 2)}
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 12, color: t.faint, marginTop: 4 }}
                >
                  {b.n0} orders · zeroForOne
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
                  {f(b.e1, 2)}
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 12, color: t.faint, marginTop: 4 }}
                >
                  {b.n1} orders · oneForZero
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
                Netting, live
              </div>
              <div style={{ fontSize: 14.5, color: t.dim }}>
                Opposite directions cancel at par. Only the residual touches pool
                liquidity.
              </div>
            </div>

            <div style={{ marginTop: 26 }}>
              <NettingBars
                netPct={b.netPct}
                res0Pct={b.res0Pct}
                res1Pct={b.res1Pct}
                matched={b.matched}
                residualAmount={b.residualAmount}
                residualZeroForOne={b.residualZeroForOne}
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
                      b.e0 + b.e1 > 0
                        ? `${f(((b.matched * 2) / Math.max(b.e0 + b.e1, 1e-9)) * 100, 1)}%`
                        : "0%",
                    fg: accent,
                  },
                  {
                    k: "RESIDUAL TO CURVE",
                    v: b.count ? `${f(b.residualAmount, 2)}` : "—",
                  },
                  { k: "POOL MID NOW", v: b.price ? f(b.price, 5) : "—" },
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
              Orders in this window
            </div>
            <div className="mono" style={{ fontSize: 11, color: t.faint }}>
              SHARED FATE
            </div>
          </div>

          {b.orders.length > 0 ? (
            <div style={{ maxHeight: 620, overflowY: "auto" }}>
              {[...b.orders].reverse().map((o, i) => {
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

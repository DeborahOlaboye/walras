"use client";

import { useEffect, useState } from "react";

import { useUi } from "@/components/AppShell";
import { Panel, StatGrid } from "@/components/Stat";
import { useSettled } from "@/hooks/useSettled";
import { useWallet } from "@/hooks/useWallet";
import { POOL_ID, SYM0, SYM1, explorerTx } from "@/lib/config";
import {
  f,
  fromWei,
  shortAddress,
  sqrtPriceToPrice,
} from "@/lib/format";
import { isEligible } from "@/lib/netting";

export default function ExplorerScreen() {
  const { t, accent } = useUi();
  const { address } = useWallet();
  const { batches, loading } = useSettled();
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!selected && batches.length) setSelected(String(batches[0].id));
  }, [batches, selected]);

  const d = batches.find((b) => String(b.id) === selected) ?? batches[0] ?? null;
  const price = d ? sqrtPriceToPrice(d.clearingSqrtPriceX96) : 0;

  // Which orders actually cleared, judged the same way the contract judges them:
  // at the settled price, as of the moment the batch closed.
  const filledCount =
    d && !d.failed
      ? d.orders.filter((o) => isEligible(o, d.clearingSqrtPriceX96, 0n)).length
      : 0;

  const matched = d
    ? fromWei(d.gross0 + d.gross1) - fromWei(d.residualAmount)
    : 0;

  return (
    <div
      style={{
        padding: "34px 30px 90px",
        maxWidth: 1400,
        display: "flex",
        flexDirection: "column",
        gap: 26,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 24,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.03em" }}>
            Settlement receipt
          </div>
          <div style={{ fontSize: 15, color: t.dim, marginTop: 6 }}>
            One price for the whole window. Verifiable order by order.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {batches.map((b) => {
            const active = String(b.id) === selected;
            return (
              <button
                key={String(b.id)}
                onClick={() => setSelected(String(b.id))}
                className="mono"
                style={{
                  padding: "10px 15px",
                  borderRadius: 999,
                  border: `1px solid ${active ? accent : t.line}`,
                  background: active ? accent : "transparent",
                  color: active ? "var(--onAcc)" : t.dim,
                  fontSize: 11.5,
                }}
              >
                #{String(b.id)}
              </button>
            );
          })}
        </div>
      </div>

      {loading && !d ? (
        <Panel padding={48} style={{ textAlign: "center", color: t.dim }}>
          Reading settled batches from chain…
        </Panel>
      ) : !d ? (
        <Panel padding={48} style={{ textAlign: "center", color: t.dim }}>
          No batch has settled yet. Submit an order, wait out the window, then trigger
          settlement — the receipt appears here.
        </Panel>
      ) : (
        <>
          <StatGrid
            columns={4}
            padding="22px 24px"
            valueSize={26}
            items={
              d.failed
                ? [
                    { k: "CLEARING PRICE", v: "VOID", sub: "settlement reverted" },
                    {
                      k: "ORDERS",
                      v: String(d.orders.length),
                      sub: "all refunded whole",
                    },
                    { k: "TO LPS", v: "0", sub: "no surplus realised", fg: t.dim },
                    {
                      k: "EVENT",
                      v: "FAILED",
                      sub: "BatchSettlementFailed",
                      fg: t.dim,
                    },
                  ]
                : [
                    {
                      k: "CLEARING PRICE P*",
                      v: f(price, 5),
                      sub: `${SYM1} per ${SYM0} · uniform`,
                      fg: accent,
                    },
                    {
                      k: "NETTED INTERNALLY",
                      v: f(Math.max(matched, 0), 2),
                      sub: "never touched the curve",
                    },
                    {
                      k: "RESIDUAL TO CURVE",
                      v: f(fromWei(d.residualAmount), 2),
                      sub: `${d.residualZeroForOne ? SYM0 : SYM1} · the only AMM exposure`,
                    },
                    {
                      k: "DONATED TO LPS",
                      v: f(fromWei(d.donated0 + d.donated1), 4),
                      sub: `closed by ${shortAddress(d.closedBy)}`,
                    },
                  ]
            }
          />

          <Panel>
            <div
              className="mono"
              style={{
                display: "grid",
                gridTemplateColumns:
                  "minmax(80px,1.2fr) minmax(105px,1.3fr) minmax(60px,0.9fr) minmax(70px,1fr) minmax(70px,1.1fr)",
                gap: 12,
                padding: "13px 20px",
                borderBottom: "1px solid var(--line)",
                background: t.panel,
                fontSize: 10.5,
                color: t.faint,
                letterSpacing: "0.05em",
              }}
            >
              <div>OWNER</div>
              <div>DIRECTION</div>
              <div style={{ textAlign: "right" }}>INPUT</div>
              <div style={{ textAlign: "right" }}>FILLED AT</div>
              <div style={{ textAlign: "right" }}>OUTCOME</div>
            </div>

            {d.orders.map((o, i) => {
              const mine =
                address && o.owner.toLowerCase() === address.toLowerCase();
              const filled =
                !d.failed && isEligible(o, d.clearingSqrtPriceX96, 0n);
              return (
                <div
                  key={`${o.owner}-${i}`}
                  className="mono"
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "minmax(80px,1.2fr) minmax(105px,1.3fr) minmax(60px,0.9fr) minmax(70px,1fr) minmax(70px,1.1fr)",
                    gap: 12,
                    padding: "14px 20px",
                    borderBottom: `1px solid ${t.panel2}`,
                    fontSize: 12,
                    background: mine ? t.panel2 : "transparent",
                    whiteSpace: "nowrap",
                  }}
                >
                  <div
                    style={{
                      color: t.dim,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {mine ? "you · " : ""}
                    {shortAddress(o.owner)}
                  </div>
                  <div style={{ color: o.zeroForOne ? accent : t.bone }}>
                    {o.zeroForOne ? `${SYM0} → ${SYM1}` : `${SYM1} → ${SYM0}`}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    {f(fromWei(o.amountIn), 2)}
                  </div>
                  <div
                    style={{
                      textAlign: "right",
                      color: filled ? t.fg : t.dim,
                    }}
                  >
                    {d.failed ? "void" : filled ? f(price, 5) : "—"}
                  </div>
                  <div
                    style={{
                      textAlign: "right",
                      color: filled ? t.fg : t.dim,
                    }}
                  >
                    {d.failed ? "refunded" : filled ? "filled" : "refunded"}
                  </div>
                </div>
              );
            })}

            <div
              className="mono"
              style={{ padding: "14px 20px", fontSize: 11, color: t.faint }}
            >
              {d.failed
                ? "Settlement reverted — every input returned, no price applied."
                : `${filledCount} of ${d.orders.length} orders filled, all at ${f(price, 5)}. No ordering advantage exists inside a batch.`}
            </div>
          </Panel>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 20,
              alignItems: "start",
            }}
          >
            <Panel padding={22}>
              <div
                className="mono"
                style={{ fontSize: 11, color: t.faint, letterSpacing: "0.05em" }}
              >
                WHERE THE SURPLUS WENT
              </div>
              <div
                style={{
                  marginTop: 16,
                  display: "flex",
                  flexDirection: "column",
                  gap: 13,
                }}
              >
                {[
                  [
                    `Donated to pool LPs (${SYM0})`,
                    f(fromWei(d.donated0), 4),
                  ],
                  [
                    `Donated to pool LPs (${SYM1})`,
                    f(fromWei(d.donated1), 4),
                  ],
                  ["Extractable by searchers", "0"],
                ].map(([k, v]) => (
                  <div
                    key={k}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      gap: 12,
                    }}
                  >
                    <span style={{ fontSize: 14, color: t.dim }}>{k}</span>
                    <span className="mono" style={{ fontSize: 13.5 }}>
                      {v}
                    </span>
                  </div>
                ))}
              </div>
              <div
                style={{
                  marginTop: 18,
                  borderTop: "1px solid var(--line)",
                  paddingTop: 14,
                  fontSize: 14,
                  lineHeight: 1.5,
                  color: t.dim,
                  textWrap: "pretty",
                }}
              >
                In a continuous pool this spread is a searcher&apos;s profit. Here it
                goes to LPs, less the bounty that paid for settlement gas.
              </div>
            </Panel>

            <Panel padding={22}>
              <div
                className="mono"
                style={{ fontSize: 11, color: t.faint, letterSpacing: "0.05em" }}
              >
                ON-CHAIN
              </div>
              <div
                style={{
                  marginTop: 14,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                {[
                  ["poolId", `${POOL_ID.slice(0, 10)}…${POOL_ID.slice(-6)}`],
                  ["batchId", String(d.id)],
                  [
                    "sqrtPriceX96",
                    d.failed ? "—" : d.clearingSqrtPriceX96.toString(),
                  ],
                  ["closedBy", shortAddress(d.closedBy)],
                  [
                    "event",
                    d.failed ? "BatchSettlementFailed" : "BatchSettled",
                  ],
                ].map(([k, v]) => (
                  <div
                    key={k}
                    className="mono"
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      fontSize: 11,
                    }}
                  >
                    <span style={{ color: t.dim }}>{k}</span>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {v}
                    </span>
                  </div>
                ))}
                <a
                  href={explorerTx(d.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="mono"
                  style={{ fontSize: 11, marginTop: 4 }}
                >
                  view settlement tx →
                </a>
              </div>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

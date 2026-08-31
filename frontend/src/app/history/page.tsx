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
            What happened in each group
          </div>
          <div style={{ fontSize: 15, color: t.dim, marginTop: 6 }}>
            Every order in a group trades at one price. You can check each one here.
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
          Loading past groups…
        </Panel>
      ) : !d ? (
        <Panel padding={48} style={{ textAlign: "center", color: t.dim }}>
          No group has traded yet. Place an order, wait out the minute, then close the group —
          what happened will show up here.
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
                    { k: "PRICE", v: "NONE", sub: "the group failed to trade" },
                    {
                      k: "ORDERS",
                      v: String(d.orders.length),
                      sub: "everyone got their tokens back",
                    },
                    { k: "TO POOL FUNDERS", v: "0", sub: "nothing was earned", fg: t.dim },
                    {
                      k: "RESULT",
                      v: "FAILED",
                      sub: "nobody traded, nobody lost anything",
                      fg: t.dim,
                    },
                  ]
                : [
                    {
                      k: "PRICE EVERYONE GOT",
                      v: f(price, 5),
                      sub: `${SYM1} for every 1 ${SYM0}`,
                      fg: accent,
                    },
                    {
                      k: "MATCHED WITH EACH OTHER",
                      v: f(Math.max(matched, 0), 2),
                      sub: "traded person to person, not with the pool",
                    },
                    {
                      k: "LEFT OVER FOR THE POOL",
                      v: f(fromWei(d.residualAmount), 2),
                      sub: `${d.residualZeroForOne ? SYM0 : SYM1} · the only part the pool handled`,
                    },
                    {
                      k: "KEPT FOR POOL FUNDERS",
                      v: f(fromWei(d.donated0 + d.donated1), 4),
                      sub: `group closed by ${shortAddress(d.closedBy)}`,
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
              <div>WHO</div>
              <div>WHAT THEY SOLD</div>
              <div style={{ textAlign: "right" }}>AMOUNT</div>
              <div style={{ textAlign: "right" }}>PRICE</div>
              <div style={{ textAlign: "right" }}>RESULT</div>
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
                    {o.zeroForOne ? `sold ${SYM0}` : `sold ${SYM1}`}
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
                    {d.failed ? "none" : filled ? f(price, 5) : "—"}
                  </div>
                  <div
                    style={{
                      textAlign: "right",
                      color: filled ? t.fg : t.dim,
                    }}
                  >
                    {d.failed ? "given back" : filled ? "traded" : "given back"}
                  </div>
                </div>
              );
            })}

            <div
              className="mono"
              style={{ padding: "14px 20px", fontSize: 11, color: t.faint }}
            >
              {d.failed
                ? "This group failed to trade, so everyone got their tokens back and no price was applied."
                : `${filledCount} of ${d.orders.length} orders traded, every one of them at ${f(price, 5)}. Being earlier or later in the group made no difference.`}
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
                WHERE THE EXTRA VALUE WENT
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
                    `Kept for people who fund the pool (${SYM0})`,
                    f(fromWei(d.donated0), 4),
                  ],
                  [
                    `Kept for people who fund the pool (${SYM1})`,
                    f(fromWei(d.donated1), 4),
                  ],
                  ["Taken by bots", "0"],
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
                On a normal exchange a bot would pocket this. Here it stays with the people who fund the pool, apart from a small reward to whoever paid the gas to close the group.
              </div>
            </Panel>

            <Panel padding={22}>
              <div
                className="mono"
                style={{ fontSize: 11, color: t.faint, letterSpacing: "0.05em" }}
              >
                RAW DETAILS FROM THE BLOCKCHAIN
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
                  view this on the block explorer →
                </a>
              </div>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

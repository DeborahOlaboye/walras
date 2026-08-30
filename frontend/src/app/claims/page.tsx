"use client";

import { useState } from "react";

import { useUi } from "@/components/AppShell";
import { Panel } from "@/components/Stat";
import { useActions } from "@/hooks/useActions";
import { useMyOrders, type MyOrder } from "@/hooks/useMyOrders";
import { useWallet } from "@/hooks/useWallet";
import { SYM0, SYM1, addresses } from "@/lib/config";
import { f, fromWei, shortAddress, sqrtPriceToPrice } from "@/lib/format";

export default function ClaimsScreen() {
  const { t, accent } = useUi();
  const { address } = useWallet();
  const [nonce, setNonce] = useState(0);
  const { groups, loading } = useMyOrders(address, nonce);
  const { claim, pending } = useActions(() => setNonce((n) => n + 1));

  const claimableCount = groups.reduce(
    (n, g) =>
      n + g.orders.filter((o) => o.settled && !o.claimed && o.claimable > 0n).length,
    0,
  );

  async function claimAll() {
    for (const g of groups) {
      for (const o of g.orders) {
        if (o.settled && !o.claimed && o.claimable > 0n) {
          await claim(o.batchId, o.orderIndex);
        }
      }
    }
  }

  const outcomeOf = (o: MyOrder): { label: string; fg: string } => {
    if (!o.settled) return { label: "ESCROWED", fg: t.dim };
    if (o.failed) return { label: "REFUNDED · BATCH FAILED", fg: t.dim };
    if (o.filled) return { label: "FILLED AT P*", fg: t.fg };
    return { label: "REFUNDED · UNFILLED", fg: t.dim };
  };

  return (
    <div
      style={{
        padding: "34px 30px 90px",
        maxWidth: 1240,
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
            My orders
          </div>
          <div style={{ fontSize: 15, color: t.dim, marginTop: 6 }}>
            Claims are pull-based, per order. Proceeds always route to the owner.
          </div>
        </div>
        <button
          onClick={claimAll}
          disabled={!claimableCount || pending !== null}
          style={{
            padding: "13px 20px",
            borderRadius: 10,
            background: claimableCount ? accent : "transparent",
            border: `1px solid ${claimableCount ? accent : t.line}`,
            color: claimableCount ? "var(--onAcc)" : t.faint,
            fontWeight: 600,
          }}
        >
          {pending === "Claim" ? "Claiming…" : `Claim all · ${claimableCount}`}
        </button>
      </div>

      {!address ? (
        <Panel padding={48} style={{ textAlign: "center", color: t.dim }}>
          Connect a wallet to see orders you have submitted.
        </Panel>
      ) : loading && groups.length === 0 ? (
        <Panel padding={48} style={{ textAlign: "center", color: t.dim }}>
          Reading your order history…
        </Panel>
      ) : groups.length === 0 ? (
        <Panel padding={48} style={{ textAlign: "center", color: t.dim }}>
          No orders yet. Submit one and it lands in the next open window.
        </Panel>
      ) : (
        groups.map((g) => {
          const price = sqrtPriceToPrice(g.clearingSqrtPriceX96);
          const status = g.failed
            ? "SETTLEMENT FAILED"
            : g.settled
              ? "SETTLED"
              : "OPEN · ESCROWED";
          const stFg = g.failed ? t.fg : g.settled ? accent : t.dim;

          return (
            <Panel key={String(g.id)}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "15px 20px",
                  borderBottom: "1px solid var(--line)",
                  background: t.panel,
                  gap: 16,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>
                    Batch #{String(g.id)}
                  </div>
                  <div
                    className="mono"
                    style={{
                      padding: "4px 10px",
                      borderRadius: 999,
                      border: `1px solid ${g.settled ? stFg : t.line}`,
                      color: stFg,
                      fontSize: 10.5,
                      letterSpacing: "0.05em",
                    }}
                  >
                    {status}
                  </div>
                </div>
                <div className="mono" style={{ fontSize: 12, color: t.dim }}>
                  {g.settled
                    ? g.failed
                      ? "reverted · every order refunded whole"
                      : `P* ${f(price, 5)} · closed by ${shortAddress(g.closedBy)}`
                    : `${g.orders.length} order${g.orders.length === 1 ? "" : "s"} in window`}
                </div>
              </div>

              {g.orders.map((o) => {
                const outcome = outcomeOf(o);
                const canClaim = o.settled && !o.claimed && o.claimable > 0n;
                const sym =
                  o.claimCurrency.toLowerCase() ===
                  addresses.currency0.toLowerCase()
                    ? SYM0
                    : SYM1;

                return (
                  <div
                    key={String(o.orderIndex)}
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "minmax(120px,160px) minmax(0,1fr) 130px minmax(0,170px) 130px",
                      alignItems: "center",
                      gap: 16,
                      padding: "17px 20px",
                      borderBottom: `1px solid ${t.panel2}`,
                    }}
                  >
                    <div>
                      <div
                        className="mono"
                        style={{
                          fontSize: 12,
                          color: o.zeroForOne ? accent : t.bone,
                        }}
                      >
                        {o.zeroForOne
                          ? `${SYM0} → ${SYM1}`
                          : `${SYM1} → ${SYM0}`}
                      </div>
                      <div
                        className="mono"
                        style={{ fontSize: 10.5, color: t.faint, marginTop: 4 }}
                      >
                        idx {String(o.orderIndex)}
                      </div>
                    </div>

                    <div>
                      <div className="mono" style={{ fontSize: 14 }}>
                        {f(fromWei(o.amountIn), 2)}{" "}
                        {o.zeroForOne ? SYM0 : SYM1}
                      </div>
                      <div
                        className="mono"
                        style={{ fontSize: 10.5, color: t.faint, marginTop: 4 }}
                      >
                        INPUT ESCROWED
                      </div>
                    </div>

                    <div>
                      <div className="mono" style={{ fontSize: 13 }}>
                        {o.settled && !o.failed ? f(price, 5) : "—"}
                      </div>
                      <div
                        className="mono"
                        style={{ fontSize: 10.5, color: t.faint, marginTop: 4 }}
                      >
                        CLEARING P*
                      </div>
                    </div>

                    <div>
                      <div
                        className="mono"
                        style={{ fontSize: 13, color: outcome.fg }}
                      >
                        {o.settled
                          ? `${f(fromWei(o.claimable), 4)} ${sym}`
                          : "escrowed"}
                      </div>
                      <div
                        className="mono"
                        style={{ fontSize: 10.5, color: t.faint, marginTop: 4 }}
                      >
                        {outcome.label}
                      </div>
                    </div>

                    <button
                      onClick={() => canClaim && claim(o.batchId, o.orderIndex)}
                      disabled={!canClaim || pending !== null}
                      className="mono"
                      style={{
                        textAlign: "center",
                        padding: "11px 0",
                        borderRadius: 10,
                        border: `1px solid ${canClaim ? accent : t.line}`,
                        background: canClaim ? accent : "transparent",
                        color: canClaim ? "var(--onAcc)" : t.faint,
                        fontSize: 11,
                        letterSpacing: "0.04em",
                      }}
                    >
                      {o.claimed ? "CLAIMED" : canClaim ? "CLAIM" : "PENDING"}
                    </button>
                  </div>
                );
              })}
            </Panel>
          );
        })
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 20,
        }}
      >
        {[
          {
            t: "FILLED",
            d: "Received proceeds at the batch clearing price, identical to every other filled order.",
            fg: accent,
          },
          {
            t: "REFUNDED · UNFILLED",
            d: "Your own limit or deadline excluded you. Input returned whole — never a partial fill.",
            fg: t.bone,
          },
          {
            t: "REFUNDED · FAILED BATCH",
            d: "Settlement reverted. The batch pays nobody and refunds everybody.",
            fg: t.dim,
          },
        ].map((l) => (
          <div
            key={l.t}
            style={{ borderLeft: `2px solid ${l.fg}`, padding: "2px 0 2px 14px" }}
          >
            <div
              className="mono"
              style={{ fontSize: 11, letterSpacing: "0.05em", color: l.fg }}
            >
              {l.t}
            </div>
            <div
              style={{
                fontSize: 14,
                lineHeight: 1.5,
                color: t.dim,
                marginTop: 6,
                textWrap: "pretty",
              }}
            >
              {l.d}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

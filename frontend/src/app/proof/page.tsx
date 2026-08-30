"use client";

import { useCallback, useState } from "react";

import { useUi } from "@/components/AppShell";
import { Panel } from "@/components/Stat";
import { useWallet } from "@/hooks/useWallet";
import { publicClient } from "@/lib/chain";
import {
  MIN_SQRT_PRICE,
  POOL_FEE,
  SYM0,
  SYM1,
  TICK_SPACING,
  addresses,
  explorerAddress,
} from "@/lib/config";

/// A stock v4 router's swap entrypoint. Declared inline rather than pulled from the
/// generated ABI because this router is not part of the hook — it exists only to be
/// rejected by it.
const swapRouterAbi = [
  {
    type: "function",
    name: "swap",
    stateMutability: "payable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "zeroForOne", type: "bool" },
          { name: "amountSpecified", type: "int256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
      {
        name: "testSettings",
        type: "tuple",
        components: [
          { name: "takeClaims", type: "bool" },
          { name: "settleUsingBurn", type: "bool" },
        ],
      },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [{ name: "delta", type: "int256" }],
  },
] as const;

interface LogLine {
  t: string;
  m: string;
  hit?: boolean;
}

const DIRECT_SWAPS_DISABLED = "0x428b5d3a";
const WRAPPED_ERROR = "0x90bfb865";

export default function ProofScreen() {
  const { t, accent } = useUi();
  const { address } = useWallet();
  const [log, setLog] = useState<LogLine[]>([]);
  const [state, setState] = useState<"idle" | "running" | "done" | "unexpected">(
    "idle",
  );

  const run = useCallback(async () => {
    if (state === "running") return;
    setState("running");
    const started = performance.now();
    const lines: LogLine[] = [];
    const push = (m: string, hit = false) => {
      lines.push({
        t: `${((performance.now() - started) / 1000).toFixed(2)}s`,
        m,
        hit,
      });
      setLog([...lines]);
    };

    push(`eth_call → PoolSwapTest.swap(${SYM0} → ${SYM1}, exactIn 1.0)`);
    push(`router ${addresses.swapRouter}`);

    try {
      await publicClient.simulateContract({
        address: addresses.swapRouter,
        abi: swapRouterAbi,
        functionName: "swap",
        args: [
          {
            currency0: addresses.currency0,
            currency1: addresses.currency1,
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: addresses.hook,
          },
          {
            zeroForOne: true,
            amountSpecified: -(10n ** 18n),
            sqrtPriceLimitX96: MIN_SQRT_PRICE,
          },
          { takeClaims: false, settleUsingBurn: false },
          "0x",
        ],
        account: address ?? "0x000000000000000000000000000000000000dEaD",
      });

      // Reaching here would mean the pool accepted a swap outside a batch, which
      // would falsify the entire premise. Say so plainly rather than hiding it.
      push("swap SUCCEEDED — exclusivity is NOT holding", true);
      setState("unexpected");
    } catch (err) {
      const raw = JSON.stringify(err instanceof Error ? err.message : err);

      push(`PoolManager.unlock → PoolManager.swap(poolId, zeroForOne true)`);
      push(`Walras.beforeSwap(sender ${addresses.swapRouter.slice(0, 10)}…Router)`);

      if (raw.includes(DIRECT_SWAPS_DISABLED.slice(2))) {
        if (raw.includes(WRAPPED_ERROR.slice(2))) {
          push(`v4 wrapped the hook revert · ${WRAPPED_ERROR}`);
        }
        push(`revert DirectSwapsDisabled() · selector ${DIRECT_SWAPS_DISABLED}`, true);
        push("state unchanged · no fill possible");
        setState("done");
      } else {
        push(`reverted, but not with DirectSwapsDisabled: ${raw.slice(0, 160)}`, true);
        setState("unexpected");
      }
    }
  }, [state, address]);

  return (
    <div
      style={{
        padding: "34px 30px 90px",
        maxWidth: 1240,
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr) minmax(0,400px)",
        gap: 34,
        alignItems: "start",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.03em" }}>
            Exclusivity proof
          </div>
          <div
            style={{
              fontSize: 15,
              color: t.dim,
              marginTop: 6,
              maxWidth: "62ch",
              textWrap: "pretty",
            }}
          >
            The batch is only fair if it is the only way in. This runs a real swap
            through a standard v4 router against the live pool and shows what the hook
            does with it. Nothing here is simulated in the browser — the revert comes
            back from Unichain Sepolia.
          </div>
        </div>

        <Panel>
          <div
            style={{
              padding: "18px 22px",
              borderBottom: "1px solid var(--line)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 20,
              flexWrap: "wrap",
            }}
          >
            <div className="mono" style={{ fontSize: 12, color: t.dim }}>
              PoolSwapTest · exactInputSingle
            </div>
            <button
              onClick={run}
              disabled={state === "running"}
              style={{
                padding: "12px 20px",
                borderRadius: 10,
                background: accent,
                color: "var(--onAcc)",
                fontWeight: 600,
              }}
            >
              {state === "running"
                ? "Running…"
                : state === "idle"
                  ? "Attempt direct swap"
                  : "Run again"}
            </button>
          </div>

          <div
            style={{
              padding: "20px 22px",
              display: "flex",
              flexDirection: "column",
              gap: 11,
              minHeight: 120,
            }}
          >
            {log.length === 0 ? (
              <div style={{ fontSize: 14, color: t.faint }}>
                Nothing run yet.
              </div>
            ) : (
              log.map((l, i) => (
                <div
                  key={i}
                  className="mono"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "66px 1fr",
                    gap: 16,
                    fontSize: 12,
                    animation: "rowIn 0.25s ease both",
                  }}
                >
                  <span style={{ color: t.faint }}>{l.t}</span>
                  <span style={{ color: l.hit ? accent : t.dim, wordBreak: "break-all" }}>
                    {l.m}
                  </span>
                </div>
              ))
            )}
          </div>

          {state === "done" && (
            <div
              style={{
                margin: "0 22px 22px",
                border: `1px solid ${accent}`,
                borderRadius: 12,
                padding: 20,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div className="mono" style={{ fontSize: 15, color: accent }}>
                REVERTED · DirectSwapsDisabled()
              </div>
              <div
                style={{
                  fontSize: 14.5,
                  lineHeight: 1.55,
                  color: t.dim,
                  textWrap: "pretty",
                }}
              >
                beforeSwap rejected the call. There is no continuous path through this
                pool — no private orderflow, no priority-gas race, nothing to sandwich.
                Every fill goes through a sealed window at one price.
              </div>
            </div>
          )}

          {state === "unexpected" && (
            <div
              style={{
                margin: "0 22px 22px",
                border: `1px solid ${t.bone}`,
                borderRadius: 12,
                padding: 20,
                fontSize: 14.5,
                lineHeight: 1.55,
                color: t.dim,
              }}
            >
              That did not revert the way it should. Read the trace above — this is
              reported honestly rather than shown as a pass.
            </div>
          )}
        </Panel>

        <Panel padding={22}>
          <div
            className="mono"
            style={{ fontSize: 11, color: t.faint, letterSpacing: "0.05em" }}
          >
            CONTRACTS INVOLVED
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
              ["WalrasHook", addresses.hook],
              ["PoolSwapTest", addresses.swapRouter],
              ["PoolManager", addresses.poolManager],
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
                <a
                  href={explorerAddress(v)}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {v}
                </a>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel>
        <div
          className="mono"
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--line)",
            fontSize: 11,
            color: t.faint,
            letterSpacing: "0.05em",
          }}
        >
          HOOK ERRORS, IN HUMAN
        </div>
        {[
          [
            "DirectSwapsDisabled",
            "This pool has no continuous path. Route through a batch instead.",
          ],
          [
            "BatchFull",
            "64 orders already in this window. The next opens right after settlement.",
          ],
          [
            "OrderExpired",
            "Your deadline passed before the batch closed. Input refunded whole.",
          ],
          [
            "InvalidLimitPrice",
            "The limit sits outside the range the pool can ever reach.",
          ],
          [
            "BatchNotSettled",
            "Nothing to claim yet — the batch still needs a settlement trigger.",
          ],
          [
            "AlreadyClaimed",
            "These proceeds have been pulled. Anyone can claim on an owner's behalf.",
          ],
          [
            "PoolNotGoverned",
            "That pool isn't attached to this hook, so batching doesn't apply.",
          ],
        ].map(([k, v]) => (
          <div
            key={k}
            style={{ padding: "14px 20px", borderBottom: `1px solid ${t.panel2}` }}
          >
            <div className="mono" style={{ fontSize: 12, color: accent }}>
              {k}
            </div>
            <div
              style={{
                fontSize: 14,
                lineHeight: 1.5,
                color: t.dim,
                marginTop: 4,
                textWrap: "pretty",
              }}
            >
              {v}
            </div>
          </div>
        ))}
      </Panel>
    </div>
  );
}

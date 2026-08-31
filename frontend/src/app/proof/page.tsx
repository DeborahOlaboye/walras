"use client";

import { useCallback, useState } from "react";
import { BaseError, ContractFunctionRevertedError } from "viem";

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
  // Uniswap v4 catches a reverting hook and re-throws it wrapped, so the reason the
  // hook actually gave is nested inside this. Without both errors declared here viem
  // reports only the outer selector and the real cause never surfaces.
  {
    type: "error",
    name: "WrappedError",
    inputs: [
      { name: "target", type: "address" },
      { name: "selector", type: "bytes4" },
      { name: "reason", type: "bytes" },
      { name: "details", type: "bytes" },
    ],
  },
  { type: "error", name: "DirectSwapsDisabled", inputs: [] },
] as const;

interface LogLine {
  t: string;
  /// What happened, in words.
  m: string;
  /// The raw call or error behind it. Shown smaller underneath, because the technical
  /// detail is the evidence — but it should not be the only thing a reader can see.
  detail?: string;
  hit?: boolean;
}

const DIRECT_SWAPS_DISABLED = "0x428b5d3a";
const WRAPPED_ERROR = "0x90bfb865";

/// Works out whether a failed call was refused by the hook, and whether v4 wrapped
/// that refusal on the way out.
///
/// The reason lives in one of three places depending on how far decoding got: the
/// decoded `WrappedError.reason`, a directly decoded `DirectSwapsDisabled`, or — when
/// neither decodes — the raw return data. Checking all three keeps a genuine refusal
/// from being reported as an unexpected failure.
function readRevert(err: unknown): {
  refused: boolean;
  wrapped: boolean;
  raw: string;
} {
  const raw = err instanceof Error ? err.message : String(err);

  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;

      if (name === "WrappedError") {
        const reason = reverted.data?.args?.[2];
        const hex = typeof reason === "string" ? reason.toLowerCase() : "";
        return {
          refused: hex.startsWith(DIRECT_SWAPS_DISABLED),
          wrapped: true,
          raw,
        };
      }
      if (name === "DirectSwapsDisabled") {
        return { refused: true, wrapped: false, raw };
      }
      // Undecodable: fall back to looking for either selector in the return data.
      const data = (reverted.raw ?? "").toLowerCase();
      return {
        refused: data.includes(DIRECT_SWAPS_DISABLED.slice(2)),
        wrapped: data.includes(WRAPPED_ERROR.slice(2)),
        raw,
      };
    }
  }

  const lowered = raw.toLowerCase();
  return {
    refused: lowered.includes(DIRECT_SWAPS_DISABLED.slice(2)),
    wrapped: lowered.includes(WRAPPED_ERROR.slice(2)),
    raw,
  };
}

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
    const push = (m: string, detail?: string, hit = false) => {
      lines.push({
        t: `${((performance.now() - started) / 1000).toFixed(2)}s`,
        m,
        detail,
        hit,
      });
      setLog([...lines]);
    };

    push(
      `Trying to sell 1 ${SYM0} for ${SYM1} the ordinary way, skipping the group`,
      `PoolSwapTest.swap(${SYM0} → ${SYM1}, exactIn 1.0)`,
    );
    push("Using a standard Uniswap router, not anything special", addresses.swapRouter);

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
      push(
        "The trade went through. The protection is NOT working.",
        undefined,
        true,
      );
      setState("unexpected");
    } catch (err) {
      push(
        "The request reached the pool",
        "PoolManager.unlock → PoolManager.swap(poolId, zeroForOne true)",
      );
      push(
        "Walras checked who was asking, and it was not a group settlement",
        `Walras.beforeSwap(sender ${addresses.swapRouter.slice(0, 10)}…)`,
      );

      // Decode the revert rather than searching the message text. viem prints only
      // the outermost selector, so the nested reason — the one that actually says
      // why — never appears in the string.
      const { refused, wrapped, raw } = readRevert(err);

      if (refused) {
        if (wrapped) {
          push(
            "Uniswap wrapped the refusal before passing it back",
            `WrappedError · ${WRAPPED_ERROR}`,
          );
        }
        push(
          "Refused. The pool will not trade outside a group.",
          `DirectSwapsDisabled() · ${DIRECT_SWAPS_DISABLED}`,
          true,
        );
        push("Nothing changed and no tokens moved — the trade was impossible");
        setState("done");
      } else {
        push(
          "It was refused, but not for the reason expected — see the raw error",
          raw.slice(0, 200),
          true,
        );
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
            Proof there is no way around it
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
            Grouping orders only protects you if nobody can skip the group. This actually tries to trade against the live pool the ordinary way, and shows you it being refused. This is a real call to the network, not an animation.
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
              A REAL CALL TO THE LIVE POOL
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
                  ? "Try to trade the normal way"
                  : "Try again"}
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
                Press the button and watch the pool refuse the trade.
              </div>
            ) : (
              log.map((l, i) => (
                <div
                  key={i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "66px 1fr",
                    gap: 16,
                    animation: "rowIn 0.25s ease both",
                  }}
                >
                  <span
                    className="mono"
                    style={{ fontSize: 12, color: t.faint, paddingTop: 1 }}
                  >
                    {l.t}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span
                      style={{
                        fontSize: 14,
                        color: l.hit ? accent : t.fg,
                        textWrap: "pretty",
                      }}
                    >
                      {l.m}
                    </span>
                    {l.detail && (
                      <span
                        className="mono"
                        style={{
                          display: "block",
                          marginTop: 3,
                          fontSize: 11,
                          color: t.faint,
                          wordBreak: "break-all",
                        }}
                      >
                        {l.detail}
                      </span>
                    )}
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
                The pool refused the trade. There is no way to trade here except by joining a group, so there is no queue to jump and nothing for a bot to get in front of. Every trade goes through a group, at one shared price.
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
              It was not refused the way it should have been. The details are above — this is shown honestly rather than pretended to be a pass.
            </div>
          )}
        </Panel>

        <Panel padding={22}>
          <div
            className="mono"
            style={{ fontSize: 11, color: t.faint, letterSpacing: "0.05em" }}
          >
            THE CONTRACTS INVOLVED
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
          WHAT EACH REFUSAL MEANS
        </div>
        {[
          [
            "DirectSwapsDisabled",
            "You cannot trade here directly. Place an order and join a group instead.",
          ],
          [
            "BatchFull",
            "This group is full at 64 orders. A new one starts as soon as this one trades.",
          ],
          [
            "OrderExpired",
            "Your order expired before its group traded, so you got all your tokens back.",
          ],
          [
            "InvalidLimitPrice",
            "The price limit you set is outside anything this pool could reach.",
          ],
          [
            "BatchNotSettled",
            "Nothing to collect yet — this group has not traded.",
          ],
          [
            "AlreadyClaimed",
            "Already collected. Anyone can press collect, but tokens always go to the owner.",
          ],
          [
            "PoolNotGoverned",
            "That pool does not use Walras, so none of this applies to it.",
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

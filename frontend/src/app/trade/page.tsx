"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { useUi } from "@/components/AppShell";
import { Panel } from "@/components/Stat";
import { useActions, useBalances } from "@/hooks/useActions";
import { useBatchView } from "@/hooks/useBatchView";
import { useWallet } from "@/hooks/useWallet";
import {
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  SYM0,
  SYM1,
} from "@/lib/config";
import { f, fromWei, priceToSqrtPriceX96, secondsLeft, toWei } from "@/lib/format";

/// In minutes. The deadline is checked when the batch actually settles, and settlement
/// waits for whoever next touches the pool — on quiet traffic that can be far longer
/// than the batch window suggests, so the longest option is the safe default.
const DEADLINES = [1, 5, 15, 60] as const;
/// Tolerance from the pool's current price, rather than a raw sqrtPriceX96. Exposing
/// Q64.96 to a person would be hostile; the contract still receives the encoded bound.
const LIMITS = [null, 0.05, 0.1, 0.25, 0.5] as const;

export default function TradeScreen() {
  const { t, accent, flash } = useUi();
  const b = useBatchView();
  const { address } = useWallet();
  const router = useRouter();

  const [dir, setDir] = useState(true); // true = zeroForOne
  const [amount, setAmount] = useState("");
  const [limPct, setLimPct] = useState<number | null>(null);
  const [dlMin, setDlMin] = useState<number>(60);
  const [adv, setAdv] = useState(false);
  const [nonce, setNonce] = useState(0);

  const bal = useBalances(address);
  useEffect(() => {
    bal.read();
    const iv = setInterval(bal.read, 8000);
    return () => clearInterval(iv);
  }, [bal.read, nonce]);

  const { submitOrder, approve, mintBoth, pending } = useActions(() => {
    setNonce((n) => n + 1);
    b.refresh();
  });

  const inBal = dir ? bal.bal0 : bal.bal1;
  const allowance = dir ? bal.allow0 : bal.allow1;
  const inSym = dir ? SYM0 : SYM1;
  const outSym = dir ? SYM1 : SYM0;

  const amountWei = useMemo(() => toWei(amount || "0"), [amount]);
  const needsApprove = amountWei > 0n && allowance < amountWei;
  const insufficient = amountWei > inBal;
  /// Both sides matter: a wallet holding only one token cannot place an order in the
  /// other direction, which is half the point of the demo.
  const needsTokens = bal.bal0 === 0n && bal.bal1 === 0n;
  /// Shown next to the submit button so a second order reads as a second order,
  /// rather than looking like the first one failed and is being retried.
  const myOrdersInGroup = address
    ? b.orders.filter((o) => o.owner.toLowerCase() === address.toLowerCase()).length
    : 0;

  // At the pool's current mid. Deliberately labelled as a reference rather than a
  // quote — the real fill is whatever the batch clears at.
  const est = useMemo(() => {
    const a = Number(amount) || 0;
    if (!b.price) return 0;
    return dir ? a * b.price : a / b.price;
  }, [amount, b.price, dir]);

  const sqrtLimit = useMemo(() => {
    if (limPct === null) return dir ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;
    if (!b.price) return dir ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;
    // A seller of currency0 wants a floor under the price; a seller of currency1
    // wants a ceiling over it. Same orientation the contract reads.
    const bound = dir ? b.price * (1 - limPct / 100) : b.price * (1 + limPct / 100);
    const encoded = priceToSqrtPriceX96(bound);
    return encoded < MIN_SQRT_PRICE
      ? MIN_SQRT_PRICE
      : encoded > MAX_SQRT_PRICE
        ? MAX_SQRT_PRICE
        : encoded;
  }, [limPct, b.price, dir]);

  async function onSubmit() {
    if (!address) return flash("Connect a wallet first");
    if (amountWei <= 0n) return flash("Enter an amount above zero");
    if (insufficient) return flash(`Not enough ${inSym} — use the faucet`);
    if (needsApprove) return flash(`Approve ${inSym} first`);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + dlMin * 60);
    const hash = await submitOrder(dir, amountWei, sqrtLimit, deadline);
    if (!hash) return;
    flash(`${f(Number(amount), 2)} ${inSym} held · you are in the group`);
    // The order is in a window that is already counting down, and the window is the
    // thing worth watching. Staying on this form makes a successful submission look
    // like nothing happened.
    router.push("/batch");
  }

  const chip = (active: boolean) => ({
    padding: "10px 16px",
    borderRadius: 999,
    border: `1px solid ${active ? accent : t.line}`,
    color: active ? t.fg : t.dim,
    fontSize: 11.5,
  });

  return (
    <div
      style={{
        padding: "34px 30px 90px",
        maxWidth: 1240,
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr) minmax(0,420px)",
        gap: 34,
        alignItems: "start",
      }}
    >
      <Panel padding={30}>
        <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.03em" }}>
          Place an order
        </div>
        <div style={{ fontSize: 15, color: t.dim, marginTop: 6 }}>
          Your tokens are held now. The price is decided when your group trades, a few seconds later.
        </div>

        {/* Anyone arriving with an empty wallet has nothing to trade, and the first
            thing they would otherwise hit is an approval prompt for tokens they do not
            own. Offer the faucet before the form rather than underneath it. */}
        {address && needsTokens && (
          <div
            style={{
              marginTop: 22,
              border: `1px solid ${accent}`,
              borderRadius: 12,
              padding: "18px 20px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 18,
              flexWrap: "wrap",
            }}
          >
            <div style={{ maxWidth: "44ch" }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>
                Start here — you have no test tokens yet
              </div>
              <div
                style={{
                  fontSize: 14,
                  color: t.dim,
                  marginTop: 4,
                  lineHeight: 1.45,
                  textWrap: "pretty",
                }}
              >
                These are free play tokens on a test network. They are worth nothing and
                cost nothing beyond a little test gas.
              </div>
            </div>
            <button
              onClick={() => void mintBoth()}
              disabled={pending !== null}
              style={{
                flex: "none",
                padding: "13px 22px",
                borderRadius: 10,
                background: accent,
                color: "var(--onAcc)",
                fontWeight: 600,
              }}
            >
              {pending === "Mint" ? "Sending…" : `Get 5,000 ${SYM0} + ${SYM1}`}
            </button>
          </div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
            marginTop: 26,
          }}
        >
          <button
            onClick={() => setDir(true)}
            style={{
              padding: 15,
              textAlign: "center",
              borderRadius: 10,
              fontWeight: 600,
              background: dir ? accent : "transparent",
              color: dir ? "var(--onAcc)" : t.dim,
              border: `1px solid ${dir ? accent : t.line}`,
            }}
          >
            {SYM0} → {SYM1}
          </button>
          <button
            onClick={() => setDir(false)}
            style={{
              padding: 15,
              textAlign: "center",
              borderRadius: 10,
              fontWeight: 600,
              background: !dir ? t.bone : "transparent",
              color: !dir ? t.bg : t.dim,
              border: `1px solid ${!dir ? t.bone : t.line}`,
            }}
          >
            {SYM1} → {SYM0}
          </button>
        </div>

        <div
          style={{
            marginTop: 22,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
          }}
        >
          <span
            className="mono"
            style={{ fontSize: 11, color: t.faint, letterSpacing: "0.05em" }}
          >
            AMOUNT TO SELL
          </span>
          <button
            onClick={() => setAmount(String(Math.floor(fromWei(inBal))))}
            className="mono"
            style={{ fontSize: 11.5, color: t.dim }}
          >
            balance {f(fromWei(inBal), 2)} · MAX
          </button>
        </div>

        <div
          style={{
            marginTop: 8,
            display: "flex",
            alignItems: "center",
            border: `1px solid ${insufficient ? t.bone : t.line}`,
            borderRadius: 12,
            background: t.panel,
          }}
        >
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            inputMode="decimal"
            aria-label="Amount to sell"
            className="mono"
            style={{
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "none",
              outline: "none",
              color: t.fg,
              fontSize: 30,
              padding: "17px 20px",
            }}
          />
          <div
            className="mono"
            style={{ padding: "0 20px", fontSize: 14, color: t.dim }}
          >
            {inSym}
          </div>
        </div>

        <div
          className="mono"
          style={{
            marginTop: 24,
            fontSize: 11,
            color: t.faint,
            letterSpacing: "0.05em",
          }}
        >
          CANCEL MY ORDER AFTER
        </div>
        <div style={{ marginTop: 9, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {DEADLINES.map((m) => (
            <button
              key={m}
              onClick={() => setDlMin(m)}
              className="mono"
              style={chip(dlMin === m)}
            >
              {m === 60 ? "1 hour" : `${m} min`}
            </button>
          ))}
        </div>
        <div
          style={{
            marginTop: 9,
            fontSize: 12.5,
            color: t.faint,
            lineHeight: 1.45,
            textWrap: "pretty",
          }}
        >
          If your group has not traded by then, you get all your tokens back instead. Groups
          usually trade within seconds, but on a quiet pool it can take longer — so give
          it room unless you want the order to expire.
        </div>

        <div
          style={{
            marginTop: 26,
            borderTop: "1px solid var(--line)",
            paddingTop: 20,
          }}
        >
          <button
            onClick={() => setAdv((a) => !a)}
            className="mono"
            style={{
              display: "flex",
              justifyContent: "space-between",
              width: "100%",
              fontSize: 11.5,
              color: t.dim,
              letterSpacing: "0.04em",
            }}
          >
            <span>
              LIMIT PRICE ·{" "}
              {limPct === null
                ? "ACCEPT WHATEVER PRICE THE GROUP GETS"
                : `accept up to ${limPct}% worse than pool`}
            </span>
            <span>{adv ? "−" : "+"}</span>
          </button>

          {adv && (
            <div
              style={{
                marginTop: 14,
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <div
                style={{
                  fontSize: 14,
                  color: t.dim,
                  lineHeight: 1.5,
                  textWrap: "pretty",
                }}
              >
                The worst price you are willing to accept, set as a percentage below
                the current one. If the group ends up trading worse than this, you are
                simply left out and get all your tokens back — you never get a partial
                trade.
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {LIMITS.map((v) => (
                  <button
                    key={String(v)}
                    onClick={() => setLimPct(v)}
                    className="mono"
                    style={chip(limPct === v)}
                  >
                    {v === null ? "any price" : `−${v}%`}
                  </button>
                ))}
              </div>
              <div
                className="mono"
                style={{ fontSize: 11, color: t.faint, wordBreak: "break-all" }}
              >
                sent to the contract as {sqrtLimit.toString()}
              </div>
            </div>
          )}
        </div>

        {needsApprove && (
          <button
            onClick={() => approve(dir ? 0 : 1)}
            disabled={pending !== null}
            style={{
              marginTop: 22,
              width: "100%",
              padding: 16,
              textAlign: "center",
              borderRadius: 12,
              border: `1px solid ${accent}`,
              color: accent,
              fontWeight: 600,
            }}
          >
            {pending === "Approve"
              ? "Approving…"
              : `Step 1 of 2 · Allow Walras to use your ${inSym}`}
          </button>
        )}

        {/* Setup and the order itself are separate signatures, and unlabelled prompts
            are easily mistaken for repeated attempts at the same thing — someone can
            sign four times and believe they placed four orders. */}
        {needsApprove && (
          <div
            style={{
              marginTop: 10,
              fontSize: 13,
              color: t.faint,
              textAlign: "center",
              lineHeight: 1.45,
            }}
          >
            This one is a permission, not the order. The next button actually places it.
          </div>
        )}

        <button
          onClick={onSubmit}
          disabled={pending !== null || needsApprove || !address}
          style={{
            marginTop: 12,
            width: "100%",
            padding: 17,
            textAlign: "center",
            borderRadius: 12,
            fontWeight: 600,
            fontSize: 16,
            background: needsApprove || !address ? t.panel2 : accent,
            color: needsApprove || !address ? t.faint : "var(--onAcc)",
          }}
        >
          {pending === "Submit"
            ? "Placing…"
            : !address
              ? "Connect a wallet"
              : `${needsApprove ? "Step 2 of 2 · " : ""}Place order for ${f(Number(amount) || 0, 2)} ${inSym}`}
        </button>

        <div
          className="mono"
          style={{
            marginTop: 10,
            textAlign: "center",
            fontSize: 11,
            color: t.faint,
          }}
        >
          {b.phase === "open"
            ? `joins group #${String(b.currentId)} · ${secondsLeft(b.remainMs)} left to join`
            : `starts a new ${Number(b.batchDuration)}-second group`}
          {myOrdersInGroup > 0 &&
            ` · you already have ${myOrdersInGroup} in this group`}
        </div>

      </Panel>

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <Panel padding={24}>
          <div
            className="mono"
            style={{ fontSize: 11, color: t.faint, letterSpacing: "0.05em" }}
          >
            ROUGHLY WHAT YOU WOULD GET
          </div>
          <div className="mono" style={{ fontSize: 34, margin: "10px 0 4px" }}>
            ≈ {f(est, 3)} {outSym}
          </div>
          <div className="mono" style={{ fontSize: 12, color: t.dim }}>
            1 {inSym} = {f(dir ? b.price : b.price ? 1 / b.price : 0, 5)} {outSym} at
            pool mid
          </div>
          <div
            style={{
              marginTop: 18,
              borderTop: "1px solid var(--line)",
              paddingTop: 16,
              fontSize: 14,
              lineHeight: 1.55,
              color: t.dim,
              textWrap: "pretty",
            }}
          >
            This is an estimate, not a promise. Your actual price is whatever the whole
            group trades at — the same price everyone else in it gets. That is exactly
            why nobody can be shuffled in front of you to profit from your trade.
          </div>
        </Panel>

        <Panel>
          <div
            style={{
              padding: "16px 20px",
              borderBottom: "1px solid var(--line)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              The group you would join
            </div>
            <div
              className="mono"
              style={{
                fontSize: 12,
                color: b.phase === "open" ? accent : t.faint,
              }}
            >
              {b.phase === "idle" ? "IDLE" : secondsLeft(b.remainMs)}
            </div>
          </div>
          <div
            style={{
              padding: "18px 20px",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            {[
              ["group", `#${String(b.currentId)} · ${b.count} ${b.count === 1 ? "order" : "orders"}`],
              ["people selling " + SYM0, f(b.e0, 2)],
              ["people selling " + SYM1, f(b.e1, 2)],
              ["current pool price", b.price ? f(b.price, 5) : "—"],
            ].map(([k, v]) => (
              <div
                key={k}
                className="mono"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12.5,
                }}
              >
                <span style={{ color: t.dim }}>{k}</span>
                <span>{v}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

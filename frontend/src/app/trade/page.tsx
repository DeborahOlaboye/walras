"use client";

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

const DEADLINES = [1, 5, 15] as const;
/// Tolerance from the pool's current price, rather than a raw sqrtPriceX96. Exposing
/// Q64.96 to a person would be hostile; the contract still receives the encoded bound.
const LIMITS = [null, 0.05, 0.1, 0.25, 0.5] as const;

export default function TradeScreen() {
  const { t, accent, flash } = useUi();
  const b = useBatchView();
  const { address } = useWallet();

  const [dir, setDir] = useState(true); // true = zeroForOne
  const [amount, setAmount] = useState("250");
  const [limPct, setLimPct] = useState<number | null>(null);
  const [dlMin, setDlMin] = useState<number>(5);
  const [adv, setAdv] = useState(false);
  const [nonce, setNonce] = useState(0);

  const bal = useBalances(address);
  useEffect(() => {
    bal.read();
    const iv = setInterval(bal.read, 8000);
    return () => clearInterval(iv);
  }, [bal.read, nonce]);

  const { submitOrder, approve, mint, pending } = useActions(() => {
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
    if (hash) flash(`${f(Number(amount), 2)} ${inSym} escrowed · you're in the window`);
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
          Submit intent
        </div>
        <div style={{ fontSize: 15, color: t.dim, marginTop: 6 }}>
          Escrowed now, priced at the batch clearing price later.
        </div>

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
            EXACT INPUT
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
            aria-label="Exact input amount"
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
          DEADLINE
        </div>
        <div style={{ marginTop: 9, display: "flex", gap: 8 }}>
          {DEADLINES.map((m) => (
            <button
              key={m}
              onClick={() => setDlMin(m)}
              className="mono"
              style={chip(dlMin === m)}
            >
              {m} min
            </button>
          ))}
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
                ? "UNBOUNDED · TAKE THE CLEARING PRICE"
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
                Set as tolerance from the current pool price. If the clearing price
                lands worse than this, your input is refunded whole — never partially
                filled.
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {LIMITS.map((v) => (
                  <button
                    key={String(v)}
                    onClick={() => setLimPct(v)}
                    className="mono"
                    style={chip(limPct === v)}
                  >
                    {v === null ? "unbounded" : `−${v}%`}
                  </button>
                ))}
              </div>
              <div
                className="mono"
                style={{ fontSize: 11, color: t.faint, wordBreak: "break-all" }}
              >
                sqrtPriceLimitX96 = {sqrtLimit.toString()}
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
            {pending === "Approve" ? "Approving…" : `1 · Approve ${inSym} for the hook`}
          </button>
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
            ? "Escrowing…"
            : !address
              ? "Connect a wallet"
              : `${needsApprove ? "2 · " : ""}Escrow ${f(Number(amount) || 0, 2)} ${inSym} into the batch`}
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
            ? `joins batch #${String(b.currentId)} · ${secondsLeft(b.remainMs)} left`
            : `opens a new ${Number(b.batchDuration)}s window`}
        </div>

        {fromWei(inBal) < 1 && address && (
          <button
            onClick={() => mint(dir ? 0 : 1)}
            className="mono"
            style={{
              marginTop: 14,
              width: "100%",
              padding: 12,
              borderRadius: 10,
              border: `1px dashed ${t.line}`,
              color: t.dim,
              fontSize: 11.5,
            }}
          >
            {pending === "Mint" ? "MINTING…" : `FAUCET · MINT 5,000 ${inSym}`}
          </button>
        )}
      </Panel>

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <Panel padding={24}>
          <div
            className="mono"
            style={{ fontSize: 11, color: t.faint, letterSpacing: "0.05em" }}
          >
            REFERENCE AT POOL MID
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
            Not a quote. Your fill is the window&apos;s uniform clearing price — the
            same number every other order in the batch gets, which is why none of them
            can be reordered around yours.
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
              The window you&apos;d join
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
              ["batch", `#${String(b.currentId)} · ${b.count} orders`],
              ["escrowed " + SYM0, f(b.e0, 2)],
              ["escrowed " + SYM1, f(b.e1, 2)],
              ["pool mid", b.price ? f(b.price, 5) : "—"],
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

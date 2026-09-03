import { Q96, DECIMALS } from "./config";

/// Fixed-decimal display. Everything on screen is a quantity being compared down a
/// column, so figures are always padded to the same width rather than trimmed.
export function f(n: number | null | undefined, d = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

export function fromWei(v: bigint, decimals = DECIMALS): number {
  return Number(v) / 10 ** decimals;
}

export function toWei(v: string, decimals = DECIMALS): bigint {
  const clean = v.trim();
  if (!clean || Number.isNaN(Number(clean))) return 0n;
  const [whole, frac = ""] = clean.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

/// v4 carries price as sqrt(price) in Q64.96. Squaring in floating point is fine for
/// display — this number is never used to size a transaction, only to show a rate.
export function sqrtPriceToPrice(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 === 0n) return 0;
  const r = Number(sqrtPriceX96) / Number(Q96);
  return r * r;
}

export function priceToSqrtPriceX96(price: number): bigint {
  if (price <= 0) return 0n;
  return BigInt(Math.floor(Math.sqrt(price) * Number(Q96)));
}

export function shortAddress(a?: string | null): string {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/// Countdowns are the one place a tenth of a second is meaningful — the batch window
/// is measured in them.
export function secondsLeft(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

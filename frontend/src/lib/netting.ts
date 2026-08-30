import { Q96 } from "./config";

/// A mirror of contracts/src/libraries/Netting.sol, in the same integer arithmetic.
///
/// The preview the UI shows before settlement has to agree with what the contract will
/// actually do, or the "cancelled internally / residual to curve" split shown while a
/// window is open would disagree with the receipt afterwards. Floating point would drift
/// from the on-chain answer, so this keeps bigint and rounds the same direction.

export interface Order {
  owner: `0x${string}`;
  deadline: bigint;
  zeroForOne: boolean;
  sqrtPriceLimitX96: bigint;
  amountIn: bigint;
}

export interface Residual {
  zeroForOne: boolean;
  amount: bigint;
  matchedZeroForOne: bigint;
  matchedOneForZero: bigint;
}

/// Values currency0 in currency1. Applies the sqrt price twice rather than squaring it
/// first — the same reason the contract does, though here it is precision rather than
/// overflow that would suffer.
export function token1For0(amount0: bigint, sqrtPriceX96: bigint): bigint {
  return ((amount0 * sqrtPriceX96) / Q96) * sqrtPriceX96 / Q96;
}

export function token0For1(amount1: bigint, sqrtPriceX96: bigint): bigint {
  return ((amount1 * Q96) / sqrtPriceX96) * Q96 / sqrtPriceX96;
}

/// A seller of currency0 wants the price high, so its limit is a floor; a seller of
/// currency1 wants it low, so its limit is a ceiling. Same orientation v4 gives
/// sqrtPriceLimitX96 on a swap.
export function isEligible(
  order: Order,
  sqrtPriceX96: bigint,
  asOf: bigint,
): boolean {
  if (order.deadline < asOf) return false;
  return order.zeroForOne
    ? sqrtPriceX96 >= order.sqrtPriceLimitX96
    : sqrtPriceX96 <= order.sqrtPriceLimitX96;
}

export function eligibleVolume(
  orders: readonly Order[],
  sqrtPriceX96: bigint,
  asOf: bigint,
): { eligible0: bigint; eligible1: bigint } {
  let eligible0 = 0n;
  let eligible1 = 0n;
  for (const o of orders) {
    if (!isEligible(o, sqrtPriceX96, asOf)) continue;
    if (o.zeroForOne) eligible0 += o.amountIn;
    else eligible1 += o.amountIn;
  }
  return { eligible0, eligible1 };
}

export function residual(
  eligible0: bigint,
  eligible1: bigint,
  sqrtPriceX96: bigint,
): Residual {
  if (sqrtPriceX96 === 0n) {
    return {
      zeroForOne: true,
      amount: 0n,
      matchedZeroForOne: 0n,
      matchedOneForZero: 0n,
    };
  }

  const eligible1In0 = token0For1(eligible1, sqrtPriceX96);

  if (eligible0 > eligible1In0) {
    return {
      zeroForOne: true,
      amount: eligible0 - eligible1In0,
      matchedZeroForOne: eligible1In0,
      matchedOneForZero: eligible1,
    };
  }

  const eligible0In1 = token1For0(eligible0, sqrtPriceX96);
  return {
    zeroForOne: false,
    amount: eligible1 > eligible0In1 ? eligible1 - eligible0In1 : 0n,
    matchedZeroForOne: eligible0,
    matchedOneForZero: eligible0In1,
  };
}

/// How the netting bars are sized. Both sides are drawn against one shared total so the
/// matched portion lines up across them and the residual reads as the overhang it is.
export function nettingSplit(
  eligible0: bigint,
  eligible1: bigint,
  sqrtPriceX96: bigint,
): { netPct: number; res0Pct: number; res1Pct: number; matched: bigint } {
  if (sqrtPriceX96 === 0n || (eligible0 === 0n && eligible1 === 0n)) {
    return { netPct: 0, res0Pct: 0, res1Pct: 0, matched: 0n };
  }
  const e1in0 = token0For1(eligible1, sqrtPriceX96);
  const matched = eligible0 < e1in0 ? eligible0 : e1in0;
  const total = eligible0 > e1in0 ? eligible0 : e1in0;
  if (total === 0n) return { netPct: 0, res0Pct: 0, res1Pct: 0, matched: 0n };

  const pct = (v: bigint) => Number((v * 10_000n) / total) / 100;
  return {
    netPct: pct(matched),
    res0Pct: eligible0 > e1in0 ? pct(eligible0 - e1in0) : 0,
    res1Pct: e1in0 > eligible0 ? pct(e1in0 - eligible0) : 0,
    matched,
  };
}

"use client";

import { useMemo } from "react";

import { useClock, usePool, type PoolState } from "./usePool";
import { fromWei, sqrtPriceToPrice } from "@/lib/format";
import { eligibleVolume, nettingSplit, residual } from "@/lib/netting";

export type BatchPhase = "idle" | "open" | "elapsed" | "settling";

export interface BatchView extends PoolState {
  now: number;
  phase: BatchPhase;
  /// Milliseconds until the window closes. Zero once elapsed.
  remainMs: number;
  /// Fraction of the window still to run, for the progress bar.
  pct: number;
  count: number;
  e0: number;
  e1: number;
  n0: number;
  n1: number;
  price: number;
  /// Live netting preview, computed with the same integer math the contract uses.
  netPct: number;
  res0Pct: number;
  res1Pct: number;
  matched: number;
  residualAmount: number;
  residualZeroForOne: boolean;
  statusLabel: string;
  statusNote: string;
}

export function useBatchView(): BatchView {
  const pool = usePool();
  const now = useClock();

  return useMemo(() => {
    const { batch, batchDuration, orders, sqrtPriceX96 } = pool;

    const openedAtMs = batch ? Number(batch.openedAt) * 1000 : 0;
    const durMs = Number(batchDuration) * 1000;
    // A batch with no orders has never opened its window — openedAt stays zero, and an
    // idle pool deliberately runs no clock at all.
    const started = !!batch && batch.openedAt > 0n && orders.length > 0;
    const closesAt = openedAtMs + durMs;
    const remainMs = started ? Math.max(0, closesAt - now) : 0;

    const phase: BatchPhase = !started
      ? "idle"
      : remainMs > 0
        ? "open"
        : "elapsed";

    // Eligibility is judged at the price the batch would clear at. Before settlement the
    // pool's own spot is the honest reference — the contract solves for the exact figure,
    // but at parity with balanced flow the two agree.
    const asOf = BigInt(Math.floor(now / 1000));
    const { eligible0, eligible1 } = eligibleVolume(orders, sqrtPriceX96, asOf);
    const split = nettingSplit(eligible0, eligible1, sqrtPriceX96);
    const res = residual(eligible0, eligible1, sqrtPriceX96);

    const statusLabel =
      phase === "idle" ? "IDLE" : phase === "open" ? "WINDOW OPEN" : "ELAPSED";

    const statusNote =
      phase === "idle"
        ? "No batch running. The window opens the moment someone submits."
        : phase === "open"
          ? "Every order landing in this window fills at one uniform price. Nothing can be reordered against you inside it."
          : "The window has closed. Settlement is permissionless — the next interaction with this pool executes it.";

    return {
      ...pool,
      now,
      phase,
      remainMs,
      pct: started && durMs > 0 ? (remainMs / durMs) * 100 : 0,
      count: orders.length,
      e0: fromWei(pool.escrowed0),
      e1: fromWei(pool.escrowed1),
      n0: orders.filter((o) => o.zeroForOne).length,
      n1: orders.filter((o) => !o.zeroForOne).length,
      price: sqrtPriceToPrice(sqrtPriceX96),
      netPct: split.netPct,
      res0Pct: split.res0Pct,
      res1Pct: split.res1Pct,
      matched: fromWei(split.matched),
      residualAmount: fromWei(res.amount),
      residualZeroForOne: res.zeroForOne,
      statusLabel,
      statusNote,
    };
  }, [pool, now]);
}

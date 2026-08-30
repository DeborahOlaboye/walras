"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { walrasHookAbi } from "@/lib/abi";
import { publicClient } from "@/lib/chain";
import { POOL_ID, addresses } from "@/lib/config";
import type { Order } from "@/lib/netting";

export interface BatchInfo {
  id: bigint;
  openedAt: bigint;
  closedAt: bigint;
  closedBy: `0x${string}`;
  settled: boolean;
  failed: boolean;
}

export interface Settlement {
  sqrtPriceX96: bigint;
  gross0: bigint;
  payout0: bigint;
  gross1: bigint;
  payout1: bigint;
}

export interface PoolState {
  /// Immutable config, read once.
  batchDuration: bigint;
  maxOrders: number;
  bountyBips: number;
  /// The batch currently accepting orders.
  currentId: bigint;
  batch: BatchInfo | null;
  orders: Order[];
  escrowed0: bigint;
  escrowed1: bigint;
  /// Pool spot, used as the reference price for the live netting preview.
  sqrtPriceX96: bigint;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const hook = { address: addresses.hook, abi: walrasHookAbi } as const;

/// v4 keeps pool state behind `extsload` rather than getters. Slot0 lives at the first
/// word of the pool's struct in the PoolManager's `_pools` mapping — mapping slot 6 in
/// the deployed layout — so the sqrt price is one storage read rather than a call.
const POOLS_SLOT = 6n;

async function readSqrtPrice(): Promise<bigint> {
  const { keccak256, encodeAbiParameters } = await import("viem");
  const slot = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [POOL_ID, POOLS_SLOT],
    ),
  );
  const word = await publicClient.getStorageAt({
    address: addresses.poolManager,
    slot,
  });
  if (!word) return 0n;
  // slot0 packs sqrtPriceX96 in the low 160 bits.
  return BigInt(word) & ((1n << 160n) - 1n);
}

export function usePool(pollMs = 2500): PoolState {
  const [state, setState] = useState<
    Omit<PoolState, "refresh"> & { refresh?: never }
  >({
    batchDuration: 12n,
    maxOrders: 64,
    bountyBips: 500,
    currentId: 0n,
    batch: null,
    orders: [],
    escrowed0: 0n,
    escrowed1: 0n,
    sqrtPriceX96: 0n,
    loading: true,
    error: null,
  });

  const tick = useRef(0);
  const bump = useCallback(() => setState((s) => ({ ...s })), []);

  useEffect(() => {
    let alive = true;

    async function read() {
      try {
        const [duration, maxOrders, bounty, currentId, sqrtPriceX96] =
          await Promise.all([
            publicClient.readContract({ ...hook, functionName: "batchDuration" }),
            publicClient.readContract({
              ...hook,
              functionName: "maxOrdersPerBatch",
            }),
            publicClient.readContract({
              ...hook,
              functionName: "settlementBountyBips",
            }),
            publicClient.readContract({
              ...hook,
              functionName: "currentBatchId",
              args: [POOL_ID],
            }),
            readSqrtPrice(),
          ]);

        const id = currentId as bigint;

        const [raw, escrowed0, escrowed1, count] = await Promise.all([
          publicClient.readContract({
            ...hook,
            functionName: "batches",
            args: [POOL_ID, id],
          }),
          publicClient.readContract({
            ...hook,
            functionName: "escrowedZeroForOne",
            args: [POOL_ID, id],
          }),
          publicClient.readContract({
            ...hook,
            functionName: "escrowedOneForZero",
            args: [POOL_ID, id],
          }),
          publicClient.readContract({
            ...hook,
            functionName: "orderCount",
            args: [POOL_ID, id],
          }),
        ]);

        const [openedAt, closedAt, closedBy, settled, failed] = raw as [
          bigint,
          bigint,
          `0x${string}`,
          boolean,
          boolean,
        ];

        const n = Number(count as bigint);
        const orders = (await Promise.all(
          Array.from({ length: n }, (_, i) =>
            publicClient.readContract({
              ...hook,
              functionName: "getOrder",
              args: [POOL_ID, id, BigInt(i)],
            }),
          ),
        )) as unknown as Order[];

        if (!alive) return;
        setState({
          batchDuration: duration as bigint,
          maxOrders: Number(maxOrders as number),
          bountyBips: Number(bounty as number),
          currentId: id,
          batch: { id, openedAt, closedAt, closedBy, settled, failed },
          orders,
          escrowed0: escrowed0 as bigint,
          escrowed1: escrowed1 as bigint,
          sqrtPriceX96,
          loading: false,
          error: null,
        });
      } catch (e) {
        if (!alive) return;
        setState((s) => ({
          ...s,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        }));
      }
    }

    read();
    const iv = setInterval(read, pollMs);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [pollMs, tick.current]);

  const refresh = useCallback(() => {
    tick.current += 1;
    bump();
  }, [bump]);

  return { ...state, refresh } as PoolState;
}

/// A local clock, separate from chain polling. The countdown needs to move every frame
/// or so to feel like a real window closing, but the chain only needs reading every few
/// seconds — tying them together would either make the timer stutter or hammer the RPC.
export function useClock(intervalMs = 100): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(iv);
  }, [intervalMs]);
  return now;
}

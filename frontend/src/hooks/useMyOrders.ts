"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";

import { walrasHookAbi } from "@/lib/abi";
import { DEPLOY_BLOCK, getLogsChunked, publicClient } from "@/lib/chain";
import { POOL_ID, addresses, poolKey } from "@/lib/config";

export interface MyOrder {
  batchId: bigint;
  orderIndex: bigint;
  zeroForOne: boolean;
  amountIn: bigint;
  deadline: bigint;
  /// Settlement outcome, once the batch has settled.
  settled: boolean;
  failed: boolean;
  clearingSqrtPriceX96: bigint;
  claimable: bigint;
  claimCurrency: Address;
  filled: boolean;
  claimed: boolean;
}

export interface BatchGroup {
  id: bigint;
  settled: boolean;
  failed: boolean;
  closedBy: Address;
  clearingSqrtPriceX96: bigint;
  orders: MyOrder[];
}

const hook = { address: addresses.hook, abi: walrasHookAbi } as const;

/// Finds a wallet's orders from OrderSubmitted logs rather than by scanning batches.
/// The event indexes owner, so this is one filtered query instead of walking every
/// batch the pool has ever had.
export function useMyOrders(address: Address | null, refreshKey = 0) {
  const [groups, setGroups] = useState<BatchGroup[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!address) {
      setGroups([]);
      return;
    }
    setLoading(true);
    try {
      // Chunked to stay inside the RPC's 10,000 block log limit. No early stop —
      // this screen has to show every order the wallet has placed, not just recent
      // ones, or someone would find orders quietly missing from their own history.
      const logs = await getLogsChunked(
        (fromBlock, toBlock) =>
          publicClient.getContractEvents({
            ...hook,
            eventName: "OrderSubmitted",
            args: { poolId: POOL_ID, owner: address },
            fromBlock,
            toBlock,
          }),
        { fromBlock: DEPLOY_BLOCK },
      );

      // Group by batch so the UI can show one settlement price per window.
      const byBatch = new Map<string, { batchId: bigint; indices: bigint[] }>();
      for (const log of logs) {
        const a = log.args as {
          batchId?: bigint;
          orderIndex?: bigint;
        };
        if (a.batchId === undefined || a.orderIndex === undefined) continue;
        const key = a.batchId.toString();
        const entry = byBatch.get(key) ?? { batchId: a.batchId, indices: [] };
        entry.indices.push(a.orderIndex);
        byBatch.set(key, entry);
      }

      const result: BatchGroup[] = [];
      for (const { batchId, indices } of byBatch.values()) {
        const [rawBatch, rawSettlement] = await Promise.all([
          publicClient.readContract({
            ...hook,
            functionName: "batches",
            args: [POOL_ID, batchId],
          }),
          publicClient.readContract({
            ...hook,
            functionName: "settlements",
            args: [POOL_ID, batchId],
          }),
        ]);

        const [, , closedBy, settled, failed] = rawBatch as [
          bigint,
          bigint,
          Address,
          boolean,
          boolean,
        ];
        const [sqrtPriceX96] = rawSettlement as [
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
        ];

        const orders = await Promise.all(
          indices.map(async (orderIndex) => {
            const [order, claimedFlag] = await Promise.all([
              publicClient.readContract({
                ...hook,
                functionName: "getOrder",
                args: [POOL_ID, batchId, orderIndex],
              }),
              publicClient.readContract({
                ...hook,
                functionName: "claimed",
                args: [POOL_ID, batchId, orderIndex],
              }),
            ]);

            const o = order as {
              owner: Address;
              deadline: bigint;
              zeroForOne: boolean;
              sqrtPriceLimitX96: bigint;
              amountIn: bigint;
            };

            // claimable() is the contract's own answer, including the pro-rata
            // scaling applied when a side came up short. Deriving it here instead
            // would risk showing a figure the claim then disagrees with.
            let claimable = 0n;
            let claimCurrency = addresses.currency0;
            let filled = false;
            if (settled) {
              try {
                const res = (await publicClient.readContract({
                  ...hook,
                  functionName: "claimable",
                  args: [poolKey, batchId, orderIndex],
                })) as [Address, bigint, boolean];
                claimCurrency = res[0];
                claimable = res[1];
                filled = res[2];
              } catch {
                /* an unsettled or unreadable batch simply shows nothing to claim */
              }
            }

            return {
              batchId,
              orderIndex,
              zeroForOne: o.zeroForOne,
              amountIn: o.amountIn,
              deadline: o.deadline,
              settled,
              failed,
              clearingSqrtPriceX96: sqrtPriceX96,
              claimable,
              claimCurrency,
              filled,
              claimed: claimedFlag as boolean,
            } satisfies MyOrder;
          }),
        );

        result.push({
          id: batchId,
          settled,
          failed,
          closedBy,
          clearingSqrtPriceX96: sqrtPriceX96,
          orders: orders.sort((a, b) => Number(a.orderIndex - b.orderIndex)),
        });
      }

      result.sort((a, b) => Number(b.id - a.id));
      setGroups(result);
    } catch {
      /* leave the previous view in place rather than blanking on a transient RPC error */
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return { groups, loading, reload: load };
}

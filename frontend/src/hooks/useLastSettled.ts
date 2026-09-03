"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";

import { walrasHookAbi } from "@/lib/abi";
import { publicClient } from "@/lib/chain";
import { POOL_ID, addresses } from "@/lib/config";
import type { Order } from "@/lib/netting";

const hook = { address: addresses.hook, abi: walrasHookAbi } as const;

export interface LastSettled {
  id: bigint;
  clearingSqrtPriceX96: bigint;
  orders: Order[];
}

/// The most recent group that actually traded, read by walking back from the current
/// batch id rather than by scanning event logs.
///
/// Batch ids are sequential, so the previous group is simply `currentId - 1` — no logs
/// required. That matters: the log-scan version had to page through two dozen block
/// ranges for two event types on every poll, and since a failed poll keeps the previous
/// result rather than blanking the screen, one rate-limited request left the page
/// showing a group two settlements out of date.
export function useLastSettled(currentId: bigint, pollMs = 5000) {
  const [last, setLast] = useState<LastSettled | null>(null);

  const read = useCallback(async () => {
    // Look back a few groups at most: a failed settlement is skipped, but if several
    // in a row failed there is nothing worth showing anyway.
    for (let back = 1n; back <= 5n; back++) {
      if (currentId < back) break;
      const id = currentId - back;

      try {
        const [raw, count] = await Promise.all([
          publicClient.readContract({
            ...hook,
            functionName: "batches",
            args: [POOL_ID, id],
          }),
          publicClient.readContract({
            ...hook,
            functionName: "orderCount",
            args: [POOL_ID, id],
          }),
        ]);

        const [, , , settled, failed] = raw as [
          bigint,
          bigint,
          Address,
          boolean,
          boolean,
        ];
        if (!settled || failed) continue;

        const [settlement, orders] = await Promise.all([
          publicClient.readContract({
            ...hook,
            functionName: "settlements",
            args: [POOL_ID, id],
          }),
          Promise.all(
            Array.from({ length: Number(count as bigint) }, (_, i) =>
              publicClient.readContract({
                ...hook,
                functionName: "getOrder",
                args: [POOL_ID, id, BigInt(i)],
              }),
            ),
          ),
        ]);

        const [sqrtPriceX96] = settlement as [
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
        ];

        setLast({
          id,
          clearingSqrtPriceX96: sqrtPriceX96,
          orders: orders as unknown as Order[],
        });
        return;
      } catch {
        // Try the next one back rather than giving up on the whole lookup.
        continue;
      }
    }
  }, [currentId]);

  useEffect(() => {
    read();
    const iv = setInterval(read, pollMs);
    return () => clearInterval(iv);
  }, [read, pollMs]);

  return last;
}

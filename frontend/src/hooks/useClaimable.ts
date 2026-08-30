"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";

import { walrasHookAbi } from "@/lib/abi";
import { DEPLOY_BLOCK, publicClient } from "@/lib/chain";
import { POOL_ID, addresses, poolKey } from "@/lib/config";

const hook = { address: addresses.hook, abi: walrasHookAbi } as const;

/// How many of a wallet's orders are settled and still unclaimed, and whether any of
/// its orders are still sitting in an open window.
///
/// Deliberately lighter than `useMyOrders` — it answers only "is there something for
/// you to do", which the header needs on every screen. Nothing in the app told the user
/// they had proceeds waiting, which is the whole reason this exists.
export function useClaimable(address: Address | null) {
  const [claimable, setClaimable] = useState(0);
  const [pendingSettlement, setPendingSettlement] = useState(0);

  const read = useCallback(async () => {
    if (!address) {
      setClaimable(0);
      setPendingSettlement(0);
      return;
    }
    try {
      const logs = await publicClient.getContractEvents({
        ...hook,
        eventName: "OrderSubmitted",
        args: { poolId: POOL_ID, owner: address },
        fromBlock: DEPLOY_BLOCK,
        toBlock: "latest",
      });

      let ready = 0;
      let waiting = 0;

      await Promise.all(
        logs.map(async (log) => {
          const a = log.args as { batchId?: bigint; orderIndex?: bigint };
          if (a.batchId === undefined || a.orderIndex === undefined) return;

          const [rawBatch, alreadyClaimed] = await Promise.all([
            publicClient.readContract({
              ...hook,
              functionName: "batches",
              args: [POOL_ID, a.batchId],
            }),
            publicClient.readContract({
              ...hook,
              functionName: "claimed",
              args: [POOL_ID, a.batchId, a.orderIndex],
            }),
          ]);

          const [, , , settled] = rawBatch as [
            bigint,
            bigint,
            Address,
            boolean,
            boolean,
          ];

          if (!settled) {
            waiting += 1;
            return;
          }
          if (alreadyClaimed) return;

          const res = (await publicClient.readContract({
            ...hook,
            functionName: "claimable",
            args: [poolKey, a.batchId, a.orderIndex],
          })) as [Address, bigint, boolean];
          if (res[1] > 0n) ready += 1;
        }),
      );

      setClaimable(ready);
      setPendingSettlement(waiting);
    } catch {
      /* leave the last known counts rather than flashing a zero badge */
    }
  }, [address]);

  useEffect(() => {
    read();
    const iv = setInterval(read, 10_000);
    return () => clearInterval(iv);
  }, [read]);

  return { claimable, pendingSettlement, refresh: read };
}

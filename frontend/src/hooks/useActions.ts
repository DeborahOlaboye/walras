"use client";

import { useCallback, useState } from "react";
import type { Address } from "viem";

import { useUi } from "@/components/AppShell";
import { useWallet } from "./useWallet";
import { demoTokenAbi, walrasHookAbi } from "@/lib/abi";
import {
  ensureChain,
  friendlyError,
  getInjected,
  publicClient,
  walletClientFor,
} from "@/lib/chain";
import { addresses, poolKey, unichainSepolia } from "@/lib/config";

/// A large but readable allowance, rather than the usual unbounded approval. An
/// unlimited approve renders in the wallet as a 78-digit number, which reads as alarming
/// to anyone being careful — exactly the wrong first impression for someone trying the
/// app for the first time. A million covers any amount the faucet hands out.
const APPROVAL_AMOUNT = 1_000_000n * 10n ** 18n;

/// Every write the app can make. Each one waits for the receipt before reporting
/// success, so the UI never claims a batch moved before the chain agrees.
export function useActions(onDone?: () => void) {
  const { address } = useWallet();
  const { flash } = useUi();
  const [pending, setPending] = useState<string | null>(null);

  const run = useCallback(
    async (label: string, fn: (account: Address) => Promise<`0x${string}`>) => {
      if (!address) {
        flash("Connect a wallet first");
        return null;
      }
      setPending(label);
      try {
        // Never sign against whatever chain the wallet happens to be on. These
        // addresses only exist on Unichain Sepolia, so a write sent elsewhere would
        // either revert or — worse — hit an unrelated contract at the same address.
        const provider = getInjected();
        if (provider) {
          const current = (await provider.request({
            method: "eth_chainId",
          })) as string;
          if (parseInt(current, 16) !== unichainSepolia.id) {
            await ensureChain(provider);
          }
        }

        const hash = await fn(address);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status === "reverted") {
          flash(`${label} reverted`);
          return null;
        }
        onDone?.();
        return hash;
      } catch (err) {
        flash(friendlyError(err));
        return null;
      } finally {
        setPending(null);
      }
    },
    [address, flash, onDone],
  );

  const mint = useCallback(
    (which: 0 | 1) =>
      run("Mint", async (account) => {
        const wallet = walletClientFor(account);
        return wallet.writeContract({
          address: which === 0 ? addresses.currency0 : addresses.currency1,
          abi: demoTokenAbi,
          functionName: "mint",
          args: [account, 5_000n * 10n ** 18n],
          chain: null,
          account,
        });
      }),
    [run],
  );

  /// Both tokens in one action. A wallet needs each side to be able to place orders
  /// in both directions, and making someone find the faucet twice is a good way to
  /// have them give up before seeing anything work.
  const mintBoth = useCallback(async () => {
    const first = await mint(0);
    if (!first) return null;
    return mint(1);
  }, [mint]);

  const approve = useCallback(
    (which: 0 | 1) =>
      run("Approve", async (account) => {
        const wallet = walletClientFor(account);
        return wallet.writeContract({
          address: which === 0 ? addresses.currency0 : addresses.currency1,
          abi: demoTokenAbi,
          functionName: "approve",
          args: [addresses.hook, APPROVAL_AMOUNT],
          chain: null,
          account,
        });
      }),
    [run],
  );

  const submitOrder = useCallback(
    (
      zeroForOne: boolean,
      amountIn: bigint,
      sqrtPriceLimitX96: bigint,
      deadline: bigint,
    ) =>
      run("Submit", async (account) => {
        const wallet = walletClientFor(account);
        return wallet.writeContract({
          address: addresses.hook,
          abi: walrasHookAbi,
          functionName: "submitOrder",
          args: [poolKey, zeroForOne, amountIn, sqrtPriceLimitX96, deadline],
          chain: null,
          account,
        });
      }),
    [run],
  );

  /// Closing an elapsed batch. Permissionless by design — whoever calls it settles the
  /// window for everyone and earns the bounty out of the surplus.
  const poke = useCallback(
    () =>
      run("Settle", async (account) => {
        const wallet = walletClientFor(account);
        return wallet.writeContract({
          address: addresses.hook,
          abi: walrasHookAbi,
          functionName: "poke",
          args: [poolKey],
          chain: null,
          account,
        });
      }),
    [run],
  );

  const claim = useCallback(
    (batchId: bigint, orderIndex: bigint) =>
      run("Claim", async (account) => {
        const wallet = walletClientFor(account);
        return wallet.writeContract({
          address: addresses.hook,
          abi: walrasHookAbi,
          functionName: "claim",
          args: [poolKey, batchId, orderIndex],
          chain: null,
          account,
        });
      }),
    [run],
  );

  return { pending, mint, mintBoth, approve, submitOrder, poke, claim };
}

/// Token balances and the hook's allowance, polled together since the trade screen
/// needs both to decide whether to show an approve step.
export function useBalances(address: Address | null, refreshKey = 0) {
  const [state, setState] = useState({
    bal0: 0n,
    bal1: 0n,
    allow0: 0n,
    allow1: 0n,
  });

  const read = useCallback(async () => {
    if (!address) {
      setState({ bal0: 0n, bal1: 0n, allow0: 0n, allow1: 0n });
      return;
    }
    const call = (token: Address, fn: "balanceOf" | "allowance") =>
      publicClient.readContract({
        address: token,
        abi: demoTokenAbi,
        functionName: fn,
        args: fn === "balanceOf" ? [address] : [address, addresses.hook],
      }) as Promise<bigint>;

    try {
      const [bal0, bal1, allow0, allow1] = await Promise.all([
        call(addresses.currency0, "balanceOf"),
        call(addresses.currency1, "balanceOf"),
        call(addresses.currency0, "allowance"),
        call(addresses.currency1, "allowance"),
      ]);
      setState({ bal0, bal1, allow0, allow1 });
    } catch {
      /* a failed read leaves the last known figures rather than blanking the UI */
    }
  }, [address]);

  return { ...state, read, refreshKey };
}

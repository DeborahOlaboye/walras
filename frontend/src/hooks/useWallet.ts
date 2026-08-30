"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";

import { ensureChain, getInjected, publicClient } from "@/lib/chain";
import { unichainSepolia } from "@/lib/config";

export interface WalletState {
  address: Address | null;
  chainId: number | null;
  connecting: boolean;
  hasProvider: boolean;
  wrongChain: boolean;
  connect: () => Promise<void>;
  balance: bigint | null;
}

export function useWallet(): WalletState {
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [hasProvider, setHasProvider] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);

  // Reconnect silently if the wallet already authorised this origin, so a refresh
  // does not make the user click connect again.
  useEffect(() => {
    const p = getInjected();
    setHasProvider(!!p);
    if (!p) return;

    let alive = true;
    (async () => {
      try {
        const accs = (await p.request({ method: "eth_accounts" })) as Address[];
        if (alive && accs?.length) setAddress(accs[0]);
        const id = (await p.request({ method: "eth_chainId" })) as string;
        if (alive) setChainId(parseInt(id, 16));
      } catch {
        /* a wallet that refuses to answer is treated as absent */
      }
    })();

    const onAccounts = (accs: unknown) => {
      const list = accs as Address[];
      setAddress(list?.length ? list[0] : null);
    };
    const onChain = (id: unknown) => setChainId(parseInt(id as string, 16));

    p.on?.("accountsChanged", onAccounts);
    p.on?.("chainChanged", onChain);
    return () => {
      alive = false;
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, []);

  useEffect(() => {
    if (!address) {
      setBalance(null);
      return;
    }
    let alive = true;
    const read = () =>
      publicClient
        .getBalance({ address })
        .then((b) => alive && setBalance(b))
        .catch(() => {});
    read();
    const iv = setInterval(read, 12_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [address]);

  const connect = useCallback(async () => {
    const p = getInjected();
    if (!p) return;
    setConnecting(true);
    try {
      const accs = (await p.request({
        method: "eth_requestAccounts",
      })) as Address[];
      if (accs?.length) setAddress(accs[0]);
      await ensureChain(p);
      const id = (await p.request({ method: "eth_chainId" })) as string;
      setChainId(parseInt(id, 16));
    } finally {
      setConnecting(false);
    }
  }, []);

  return {
    address,
    chainId,
    connecting,
    hasProvider,
    wrongChain: chainId !== null && chainId !== unichainSepolia.id,
    connect,
    balance,
  };
}

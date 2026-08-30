"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";

import { ensureChain, getInjected, publicClient } from "@/lib/chain";
import { unichainSepolia } from "@/lib/config";

export interface WalletState {
  address: Address | null;
  chainId: number | null;
  connecting: boolean;
  switching: boolean;
  hasProvider: boolean;
  wrongChain: boolean;
  connect: () => Promise<void>;
  switchChain: () => Promise<void>;
  balance: bigint | null;
}

export function useWallet(): WalletState {
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [switching, setSwitching] = useState(false);
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

  /// Offered whenever the wallet is on the wrong chain. `ensureChain` adds the network
  /// first if the wallet has never seen it, so this is one click even for a wallet
  /// meeting Unichain Sepolia for the first time.
  const switchChain = useCallback(async () => {
    const p = getInjected();
    if (!p) return;
    setSwitching(true);
    try {
      await ensureChain(p);
      const id = (await p.request({ method: "eth_chainId" })) as string;
      setChainId(parseInt(id, 16));
    } catch {
      /* the wallet refused; the header keeps offering the switch */
    } finally {
      setSwitching(false);
    }
  }, []);

  return {
    address,
    chainId,
    connecting,
    switching,
    hasProvider,
    wrongChain: chainId !== null && chainId !== unichainSepolia.id,
    connect,
    switchChain,
    balance,
  };
}

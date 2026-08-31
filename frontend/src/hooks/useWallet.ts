"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { Address, EIP1193Provider } from "viem";

import { ensureChain, getInjected, publicClient } from "@/lib/chain";
import { unichainSepolia } from "@/lib/config";

/// Wallet state lives in one module-level store rather than in each component's copy
/// of the hook. Five screens call useWallet, and with per-instance state a disconnect
/// in the header would leave every other screen still believing it was connected —
/// and each instance ran its own balance poller.

interface State {
  address: Address | null;
  chainId: number | null;
  connecting: boolean;
  switching: boolean;
  hasProvider: boolean;
  balance: bigint | null;
}

const INITIAL: State = {
  address: null,
  chainId: null,
  connecting: false,
  switching: false,
  hasProvider: false,
  balance: null,
};

let state: State = INITIAL;
const listeners = new Set<() => void>();

function setState(patch: Partial<State>) {
  const next = { ...state, ...patch };
  // useSyncExternalStore compares snapshots by identity, so only publish a new object
  // when something actually changed — otherwise every poll re-renders every consumer.
  const changed = (Object.keys(patch) as (keyof State)[]).some(
    (k) => state[k] !== next[k],
  );
  if (!changed) return;
  state = next;
  listeners.forEach((l) => l());
}

/// An explicit disconnect has to survive a reload, or the silent reconnect below would
/// immediately undo it. Injected wallets keep the site authorised regardless — this
/// records the user's intent for this app, and `wallet_revokePermissions` handles the
/// wallet side where it is supported.
const DISCONNECTED_KEY = "walras.wallet.disconnected";

function wasDisconnected(): boolean {
  try {
    return localStorage.getItem(DISCONNECTED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDisconnect(on: boolean) {
  try {
    if (on) localStorage.setItem(DISCONNECTED_KEY, "1");
    else localStorage.removeItem(DISCONNECTED_KEY);
  } catch {
    /* a browser refusing storage just means the choice lasts one session */
  }
}

let started = false;
let balanceTimer: ReturnType<typeof setInterval> | null = null;

function pollBalance() {
  const addr = state.address;
  if (!addr) {
    setState({ balance: null });
    return;
  }
  publicClient
    .getBalance({ address: addr })
    .then((b) => {
      // Ignore a reply that arrives after the account changed underneath it.
      if (state.address === addr) setState({ balance: b });
    })
    .catch(() => {});
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;

  const p = getInjected();
  setState({ hasProvider: !!p });
  if (!p) return;

  // Reconnect silently when the wallet already authorised this origin, unless the
  // user disconnected on purpose.
  void (async () => {
    try {
      const id = (await p.request({ method: "eth_chainId" })) as string;
      setState({ chainId: parseInt(id, 16) });
      if (wasDisconnected()) return;
      const accs = (await p.request({ method: "eth_accounts" })) as Address[];
      if (accs?.length) setState({ address: accs[0] });
    } catch {
      /* a wallet that refuses to answer is treated as absent */
    }
  })();

  p.on?.("accountsChanged", (accs: unknown) => {
    const list = accs as Address[];
    if (!list?.length) {
      setState({ address: null });
      return;
    }
    // The user picking an account in the wallet is itself a reconnect.
    rememberDisconnect(false);
    setState({ address: list[0] });
  });
  p.on?.("chainChanged", (id: unknown) =>
    setState({ chainId: parseInt(id as string, 16) }),
  );

  pollBalance();
  balanceTimer = setInterval(pollBalance, 12_000);
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && balanceTimer) {
      clearInterval(balanceTimer);
      balanceTimer = null;
      started = false;
    }
  };
}

const getSnapshot = () => state;
const getServerSnapshot = () => INITIAL;

export interface WalletState extends State {
  wrongChain: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  switchChain: () => Promise<void>;
}

export function useWallet(): WalletState {
  const s = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const connect = useCallback(async () => {
    const p = getInjected();
    if (!p) return;
    setState({ connecting: true });
    try {
      const accs = (await p.request({
        method: "eth_requestAccounts",
      })) as Address[];
      if (accs?.length) {
        rememberDisconnect(false);
        setState({ address: accs[0] });
        pollBalance();
      }
      await ensureChain(p);
      const id = (await p.request({ method: "eth_chainId" })) as string;
      setState({ chainId: parseInt(id, 16) });
    } finally {
      setState({ connecting: false });
    }
  }, []);

  const disconnect = useCallback(async () => {
    rememberDisconnect(true);
    setState({ address: null, balance: null });

    // Injected wallets have no universal disconnect. Where the wallet implements
    // EIP-2255 this genuinely revokes access; where it does not, clearing local state
    // is the whole of what any dapp can do, and the flag above stops the silent
    // reconnect from bringing it straight back.
    const p = getInjected() as (EIP1193Provider & {
      request: (a: { method: string; params?: unknown }) => Promise<unknown>;
    }) | null;
    if (!p) return;
    try {
      await p.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch {
      /* wallet does not support revoking; the local disconnect still stands */
    }
  }, []);

  const switchChain = useCallback(async () => {
    const p = getInjected();
    if (!p) return;
    setState({ switching: true });
    try {
      await ensureChain(p);
      const id = (await p.request({ method: "eth_chainId" })) as string;
      setState({ chainId: parseInt(id, 16) });
    } catch {
      /* the wallet refused; the header keeps offering the switch */
    } finally {
      setState({ switching: false });
    }
  }, []);

  return {
    ...s,
    wrongChain:
      s.address !== null && s.chainId !== null && s.chainId !== unichainSepolia.id,
    connect,
    disconnect,
    switchChain,
  };
}

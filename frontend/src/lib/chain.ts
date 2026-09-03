import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  type EIP1193Provider,
} from "viem";

import { unichainSepolia } from "./config";

/// Block this deployment landed in. Event queries start here rather than at genesis —
/// nothing about this pool exists before it, and scanning 61M empty blocks would time
/// the RPC out.
export const DEPLOY_BLOCK = 61343917n;

export const publicClient = createPublicClient({
  chain: unichainSepolia,
  transport: http(),
});

/// Unichain Sepolia's RPC rejects any eth_getLogs spanning more than 10,000 blocks.
/// Blocks are about a second apart, so a single deploy-to-latest query stops working
/// roughly three hours after deployment — silently, since the error surfaces as an
/// empty result to anything that catches it.
const MAX_LOG_RANGE = 9_000n;

/// Walks a log query backwards from the head in permitted-size chunks.
///
/// Backwards because everything here wants recent activity first: the history screen
/// shows the newest groups, and a wallet's orders are almost always recent. `enough`
/// lets a caller stop as soon as it has what it needs instead of scanning to the
/// deploy block every time.
export async function getLogsChunked<T>(
  query: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  opts: {
    fromBlock: bigint;
    /// Return true to stop early. Checked after each wave, newest blocks first.
    enough?: (collected: T[]) => boolean;
    /// Hard cap on chunks, so a long-lived deployment cannot hang the UI.
    maxChunks?: number;
    /// Requests in flight at once. Chunks are independent, so issuing them one after
    /// another just multiplies the round trip — a deployment a couple of days old
    /// already spans two dozen chunks, which is seconds of dead time per screen.
    concurrency?: number;
  },
): Promise<T[]> {
  const head = await publicClient.getBlockNumber();
  const floor = opts.fromBlock;
  const maxChunks = opts.maxChunks ?? 80;
  const concurrency = opts.concurrency ?? 8;

  // Plan every range up front, newest first, so waves can be issued in parallel.
  const ranges: Array<[bigint, bigint]> = [];
  let to = head;
  while (to >= floor && ranges.length < maxChunks) {
    const from = to - MAX_LOG_RANGE + 1n > floor ? to - MAX_LOG_RANGE + 1n : floor;
    ranges.push([from, to]);
    if (from === floor) break;
    to = from - 1n;
  }

  const collected: T[] = [];
  for (let i = 0; i < ranges.length; i += concurrency) {
    const wave = ranges.slice(i, i + concurrency);
    const results = await Promise.all(
      // One failed chunk should not lose the rest of the scan.
      wave.map(([from, until]) => query(from, until).catch(() => [] as T[])),
    );
    // The wave runs newest to oldest; reversing it gives ascending block order, and
    // each successive wave is older still, so it goes on the front.
    const ascending = results.reverse().flat();
    collected.unshift(...ascending);
    if (opts.enough?.(collected)) break;
  }

  return collected;
}

/// EIP-1193 injected provider, if the browser has one. Deliberately narrow: this app
/// needs one wallet on one chain, which is the entire reason wagmi's connector suite
/// (and its dependency tree) is not here.
export function getInjected(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  return eth ?? null;
}

export function walletClientFor(account: Address) {
  const provider = getInjected();
  if (!provider) throw new Error("No injected wallet found");
  return createWalletClient({
    account,
    chain: unichainSepolia,
    transport: custom(provider),
  });
}

/// Moves the wallet to Unichain Sepolia, adding the network if it has never seen it.
/// 4902 is the EIP-1193 code for "unrecognised chain", which is the expected path for
/// a wallet meeting this testnet for the first time.
export async function ensureChain(provider: EIP1193Provider): Promise<void> {
  const hexId = `0x${unichainSepolia.id.toString(16)}`;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexId as `0x${string}` }],
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 4902) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hexId,
          chainName: unichainSepolia.name,
          nativeCurrency: unichainSepolia.nativeCurrency,
          rpcUrls: [...unichainSepolia.rpcUrls.default.http],
          blockExplorerUrls: [unichainSepolia.blockExplorers.default.url],
        },
      ],
    } as never);
  }
}

/// Pulls the human-readable custom error out of a failed call. viem surfaces the
/// decoded name once the ABI is known, but v4 wraps hook reverts in `WrappedError`,
/// so the useful selector is often nested rather than at the top level.
export function revertName(err: unknown): string | null {
  const s = err instanceof Error ? `${err.message}` : String(err);
  const known = [
    "DirectSwapsDisabled",
    "PoolNotGoverned",
    "ZeroAmount",
    "OrderExpired",
    "InvalidLimitPrice",
    "BatchFull",
    "BatchNotSettled",
    "AlreadyClaimed",
    "IncorrectNativeValue",
    "UnexpectedNativeValue",
    "InexactTransfer",
    "Reentrancy",
    "NotSelf",
  ];
  return known.find((k) => s.includes(k)) ?? null;
}

/// What to actually show a user when a transaction fails. A rejected signature is not
/// an error worth a red banner, so it gets its own quiet message.
export function friendlyError(err: unknown): string {
  const name = revertName(err);
  if (name) {
    const copy: Record<string, string> = {
      DirectSwapsDisabled:
        "This pool has no continuous path — route through a batch instead.",
      BatchFull: "This window is full. The next opens after settlement.",
      OrderExpired: "That deadline has already passed.",
      InvalidLimitPrice: "That limit sits outside the range the pool can reach.",
      BatchNotSettled: "This batch still needs a settlement trigger.",
      AlreadyClaimed: "These proceeds have already been pulled.",
      PoolNotGoverned: "That pool is not attached to this hook.",
      ZeroAmount: "Enter an amount above zero.",
    };
    return copy[name] ?? name;
  }
  const s = err instanceof Error ? err.message : String(err);
  if (/user rejected|denied transaction/i.test(s)) return "Rejected in wallet";
  if (/insufficient funds/i.test(s)) return "Not enough ETH for gas";
  return s.split("\n")[0].slice(0, 140);
}

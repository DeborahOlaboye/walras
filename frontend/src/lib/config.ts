import { defineChain } from "viem";

/// Unichain Sepolia — Uniswap's own L2, where v4 is native. The hook is live here.
export const unichainSepolia = defineChain({
  id: 1301,
  name: "Unichain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.unichain.org"] } },
  blockExplorers: {
    default: { name: "Uniscan", url: "https://sepolia.uniscan.xyz" },
  },
  testnet: true,
});

/// Live deployment, verified on Uniscan. These are defaults rather than required env
/// vars so the app runs correctly straight after a clone — nothing to configure to
/// see the deployed hook. Set the matching NEXT_PUBLIC_* var to point at a redeploy.
const DEPLOYED = {
  hook: "0x8a6c2f663B8D57D19DCE51ed61a4a2aFd93c4080",
  currency0: "0x5e5E90EaC14983d0BaB3b869BA48c7Fe8B42B076",
  currency1: "0xd4870F305C44226A4F235161E5bcBa66e2C65545",
  poolManager: "0x00B036B58a818B1BC34d502D3fE730Db729e62AC",
  liquidityRouter: "0xc6fB8C158c6FAe0988c561DA2511B67000E337B6",
  /// A stock v4 router, deployed purely so the exclusivity proof has something real to
  /// be rejected. Calling PoolManager.swap directly would fail with ManagerLocked —
  /// which says nothing about the hook — so the proof needs a caller that genuinely
  /// takes the lock and reaches beforeSwap.
  swapRouter: "0x0D19dCd70fDe5c522B17973D5E5Cbd160C6beb0F",
} as const;

const addr = (envKey: string, fallback: string) =>
  ((process.env[envKey] as `0x${string}` | undefined) ??
    fallback) as `0x${string}`;

export const addresses = {
  hook: addr("NEXT_PUBLIC_HOOK_ADDRESS", DEPLOYED.hook),
  currency0: addr("NEXT_PUBLIC_CURRENCY0", DEPLOYED.currency0),
  currency1: addr("NEXT_PUBLIC_CURRENCY1", DEPLOYED.currency1),
  poolManager: addr("NEXT_PUBLIC_POOL_MANAGER", DEPLOYED.poolManager),
  liquidityRouter: addr(
    "NEXT_PUBLIC_LIQUIDITY_ROUTER",
    DEPLOYED.liquidityRouter,
  ),
  swapRouter: addr("NEXT_PUBLIC_SWAP_ROUTER", DEPLOYED.swapRouter),
};

export const POOL_FEE = 3000;
export const TICK_SPACING = 60;

/// The PoolKey every hook call takes. v4 requires currency0 < currency1; the deploy
/// script sorts them, so this mirrors whatever it produced.
export const poolKey = {
  currency0: addresses.currency0,
  currency1: addresses.currency1,
  fee: POOL_FEE,
  tickSpacing: TICK_SPACING,
  hooks: addresses.hook,
} as const;

/// keccak256 of the abi-encoded PoolKey. Hardcoded rather than derived at runtime
/// because every read is keyed by it and it cannot change without a redeploy.
export const POOL_ID = (process.env.NEXT_PUBLIC_POOL_ID ??
  "0xa95e9ff5650cd8db14901be97d8794775f37ef9c6f82a2340cc12103a63630f0") as `0x${string}`;

export const SYM0 = "WDA";
export const SYM1 = "WDB";
export const DECIMALS = 18;

/// v4's price bounds. The hook rejects limits at or beyond them, hence the ±1 —
/// these are the widest values an order can actually pass.
export const MIN_SQRT_PRICE = 4295128739n + 1n;
export const MAX_SQRT_PRICE =
  1461446703485210103287273052203988822378723970342n - 1n;

export const Q96 = 2n ** 96n;

export const explorerTx = (hash: string) =>
  `${unichainSepolia.blockExplorers.default.url}/tx/${hash}`;
export const explorerAddress = (a: string) =>
  `${unichainSepolia.blockExplorers.default.url}/address/${a}`;

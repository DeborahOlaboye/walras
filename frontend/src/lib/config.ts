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
  hook: "0x1fd0240c08Cd81f1Affc5e70ff78500e9D0DC080",
  currency0: "0xb4825389bB57874BF526df276f6f4f13C73cA674",
  currency1: "0xfdF50d778eb0b3c06d30CDDa51996Ce2a710a89D",
  poolManager: "0x00B036B58a818B1BC34d502D3fE730Db729e62AC",
  liquidityRouter: "0x66210D5C2F83aD77084e4c79f25956828cE0d344",
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
  "0x87cc0db91c355694816d3d338ce683302a85d94ffde442837fde5757a6fa07b0") as `0x${string}`;

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

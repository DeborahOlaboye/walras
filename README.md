# Walras

A Uniswap v4 hook that enforces pool-native batch settlement with a uniform clearing price — no swap can execute against a Walras-governed pool outside a settled batch, eliminating ordering-based MEV while netting offsetting order flow away from LP liquidity.

Built for the [UHI10 Hookathon](https://atrium.academy/uniswap) (theme: *Sustainable Liquidity and MEV Protection*).

## The problem

MEV extraction remains a $550M+/year problem on Ethereum alone. Even as private-mempool tooling has suppressed easy sandwich attacks, a deeper structural issue persists at the AMM level: LPs are continuously adversely selected by arbitrageurs correcting stale pool prices (loss-versus-rebalancing, "LVR"), which pushes LPs toward wider fees or exit — the "unsustainable liquidity" problem the hookathon theme names directly.

Existing MEV-protection solutions like CoW Protocol operate as a layer *above* AMMs — solvers compete off-chain to match orders, and route unmatched flow through on-chain liquidity sources (Uniswap included) as a fallback. That means protection is opt-in: any flow that doesn't specifically route through CoW's intent system — direct router calls, other aggregators, other protocols composing against a pool — gets no protection at all, because CoW sits above the pool, not inside it.

## The mechanism

Walras moves that protection into the pool itself.

1. **Order submission.** Users submit swap intents (direction, amount, minimum output, deadline) to an escrow contract, which takes custody of the input token.
2. **Batch accumulation.** Orders accumulate over a batch window. No external keeper is required — settlement is self-triggering: the next interaction with the contract checks whether the current window has closed and settles the prior batch first.
3. **Netting.** At settlement, opposite-direction orders net against each other directly at a single uniform clearing price. Only the unmatched residual — the net imbalance — ever touches the pool's actual liquidity.
4. **Residual execution.** The residual executes once against the AMM curve via a single `PoolManager.swap()` call, initiated by Walras's own settlement logic.
5. **Exclusivity enforcement.** The hook's `beforeSwap` callback rejects any swap whose caller isn't the authorized settlement path — so no router, aggregator, or direct call can bypass the batch and trade against the pool outside it. This is what makes the protection pool-level rather than opt-in.
6. **Claims.** Settled proceeds are withdrawn via a pull-based `claim()`, so payout gas cost doesn't scale with batch size.

## Why this isn't "just CoW"

The comparison is worth addressing directly rather than leaving it implicit. CoW Protocol proves the batch-auction/uniform-clearing-price mechanism works in production — it isn't speculative. What's different here is *where the mechanism lives* and *what trust model it requires*:

| | CoW Protocol | Walras |
|---|---|---|
| Layer | Above AMMs — routes through Uniswap pools as one liquidity source among several | Inside one specific pool — the pool's own execution logic |
| Coverage | Only flow that explicitly routes through CoW's intent system | Every swap that touches the pool, regardless of caller |
| Settlement | Competitive off-chain solver network proposes and executes batches | Fully on-chain, permissionless, deterministic netting — no solver market required |

## Why this fits the theme

**MEV protection** is structural, not routing-based: sandwiching is impossible within an enforced batch, because no swap can execute outside one.

**Sustainable liquidity** follows from the same mechanism: netting shields LPs from gross toxic flow — informed/arbitrage flow tends to be one-directional and becomes the un-netted residual, while offsetting retail flow nets out before ever touching the curve. Less LVR leakage means LPs can sustain lower fees without being adversely selected away.

## Architecture

```
contracts/
├── src/
│   ├── WalrasHook.sol      — beforeSwap exclusivity enforcement, batch/settlement orchestration
│   └── mocks/
│       └── MockSettler.sol — stands in for the real settlement path in isolated tests
├── test/
│   └── WalrasHookExclusivity.t.sol
├── script/                 — deployment scripts (CREATE2 hook mining)
├── lib/                    — v4-core, v4-periphery, forge-std
├── foundry.toml
└── remappings.txt
frontend/                   — order submission UI, batch status, claims (not yet started)
```

Contract build is broken into sections, in dependency order:

1. **Hook shell + exclusivity enforcement** — `beforeSwap` rejects any swap whose caller isn't the authorized settler. Validated first as a standalone spike, since every later section depends on this assumption holding. ✅ Done, 3/3 tests passing.
2. **Order escrow / intent submission** — pulls input tokens into custody, records intents against the current batch.
3. **Batch lifecycle management** — tracks window open/close, self-triggers settlement of the prior batch on the next interaction.
4. **Order netting engine** — pure matching logic: pairs opposite-direction orders, computes the residual.
5. **Clearing price / oracle module** — v4 removed the built-in TWAP oracle v3 had, so this is built from scratch (adapted from Uniswap's reference Truncated Oracle Hook), not assumed for free.
6. **Residual settlement** — ties (1), (4), and (5) together: executes the net residual against the pool via `PoolManager.swap()`, gated by the exclusivity check.
7. **Payouts / claims** — pull-based withdrawal of settled proceeds.
8. **Hardening** — deadline expiry, zero-residual batches, all-one-direction batches, decimal/token-ordering edge cases, reentrancy.

## Tech stack

- Foundry, Solidity 0.8.26, `v4-core` / `v4-periphery` (v4.0.0)
- Deployed and tested on **Unichain Sepolia** — Uniswap's own L2, already carrying ~$70B of v4's ~$355B cumulative volume despite launching only 9 months ago. Chosen over other L2s for direct ecosystem alignment with the hookathon's primary funder (Uniswap Foundation) and because past UHI hookathon projects have preferentially deployed there.
- No sponsor integrations for this cohort (UHI10 has none) — see "stretch goals" below for what's added on pure engineering merit rather than for a prize track.

## Stretch goals (not required, added only if they earn their place)

- **Chainlink Price Feeds** as a manipulation-resistant cross-check on the clearing price before the residual trade executes — a real robustness improvement against short-window TWAP manipulation, not a decorative integration.
- Secondary Arbitrum deployment to demonstrate cross-chain robustness.

## Building and testing

```shell
cd contracts
forge build
forge test -vv
```

## Status

Section 1 of 8 complete. See the section breakdown above for what's next.

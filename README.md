# Walras

A Uniswap v4 hook that enforces pool-native batch settlement at a uniform clearing price — no swap can execute against a Walras-governed pool outside a settled batch. Ordering-based MEV becomes structurally impossible, offsetting order flow nets away from LP liquidity, and the price improvement that a normal AMM swap hands to the trader is redirected to LPs instead.

Built for the [UHI10 Hookathon](https://atrium.academy/uniswap) (theme: *Sustainable Liquidity and MEV Protection*).

## The problem

MEV extraction remains a $550M+/year problem on Ethereum alone. Even as private-mempool tooling has suppressed easy sandwich attacks, a deeper structural issue persists at the AMM level: LPs are continuously adversely selected by arbitrageurs correcting stale pool prices (loss-versus-rebalancing, "LVR"), which pushes LPs toward wider fees or exit — the "unsustainable liquidity" problem the hookathon theme names directly.

The reason LVR is hard to fix from inside an AMM is that a constant-function curve quotes a *stale* price and fills the entire trade along it. An arbitrageur who knows the true price buys at the curve's average price and captures the whole gap between that average and the true price. Every mechanism below exists to close that gap.

## The mechanism

1. **Order submission.** Users submit swap intents (direction, amount, limit price, deadline) to an escrow contract, which takes custody of the input token.

2. **Batch accumulation.** Orders accumulate over a batch window. No external keeper is required — settlement is self-triggering: the next interaction with the contract checks whether the current window has closed and settles the prior batch first. The triggering caller is reimbursed from a settlement bounty funded by batch fees, so whoever pays the O(n) settlement gas isn't left worse off than everyone they settled for.

3. **Netting.** At settlement, opposite-direction orders net against each other directly. Only the unmatched residual — the net imbalance — ever touches the pool's actual liquidity.

4. **Residual execution and price discovery.** The residual executes once against the AMM curve via a single `PoolManager.swap()` call, initiated by Walras's own settlement logic. The curve walk ends at a marginal price `P*` — the price at which batch demand, batch supply, and AMM liquidity intersect.

5. **Uniform settlement at `P*`.** Every order in the batch settles at `P*`, netted and residual alike. This is the load-bearing step, and it is what makes the mechanism work:

   - An arbitrageur correcting a stale pool price no longer captures the gap. Their intent is the residual, and it clears at the *post-correction* marginal price rather than the average price along the walk. There is no stale price left to trade against.
   - The pool internally fills the residual at the curve's average price, but Walras charges the residual trader `P*`. The difference — precisely the price improvement a normal AMM swap would have handed the arbitrageur — is retained at settlement and `donate()`d to the pool's LPs.
   - No oracle is involved anywhere. `P*` is a deterministic function of the batch's own orders and the pool's own liquidity, computable on-chain.

6. **LP compensation on netted volume.** Netted orders never touch the curve, so they would otherwise pay LPs nothing while still relying on the pool for price discovery. Walras charges netted volume the pool's own fee rate and donates it to LPs. LPs therefore earn on gross batch volume while bearing inventory risk only on the residual.

7. **Exclusivity enforcement.** The hook's `beforeSwap` callback rejects any swap whose caller isn't the authorized settlement path — so no router, aggregator, or direct call can bypass the batch and trade against the pool outside it. This is what makes the protection pool-level rather than opt-in.

8. **Claims.** Settled proceeds are withdrawn via a pull-based `claim()`, so payout gas cost doesn't scale with batch size.

### Who pays for the surplus

Settling at `P*` means the residual trader pays more than a plain AMM swap would have charged them. That is the point — but it raises a fair question, since a large honest order can be the residual just as easily as an arbitrageur can. The mechanism does not need to tell them apart, because batch composition already does.

For a trader submitting size `Q` into a batch with residual `R`:

- **Walras** fills all of `Q` at `P*`, the marginal price after only `R` has walked the curve.
- **A plain AMM** walks the curve for all of `Q`, charging the average over `[0, Q]` — approximately the marginal price at `Q/2`.

So Walras gives the trader the better fill whenever `R < Q/2`: whenever more than half their order nets away. That condition is not a parameter, it is a property of the flow itself.

Uninformed flow is precisely the flow that finds opposing interest in the batch. It nets heavily, contributes little to the residual, and pays **less** than it would on the open curve — the netted portion has no price impact whatsoever. Informed flow is one-directional by construction; that one-directionality is what makes it toxic. It nets poorly, it becomes the residual, and it pays `P*` across its full size.

There is no threshold to tune and no intent to detect, which also means there is nothing to game: an order cannot manufacture opposing flow to net against without someone genuinely taking the other side.

The remaining case is a large uninformed order arriving in a thin, one-directional batch. It pays `P*` on full size and is worse off than it would have been on the curve. In that moment it is informationally indistinguishable from an arbitrageur, and no pool-level mechanism can separate the two. The limit price is the protection: if `P*` is worse than the trader will accept, the order simply does not fill, and the cost is a missed trade rather than a bad one.

## Prior art, and where Walras differs

Batch auctions with uniform clearing prices are not a new idea, and the two systems that matter here are both in production or funded. Addressing them directly is more useful than leaving the comparison implicit.

**Angstrom** (Sorella Labs, $7.5M seed led by Paradigm, backed by the Uniswap Foundation) is the closest comparison: a Uniswap v4 hook that clears each block at a single uniform price and returns arbitrage value to LPs. Walras targets the same failure mode by the same broad mechanism. The difference is the trust and liveness model.

**CoW Protocol** proves the batch-auction mechanism works at scale, but operates as a layer *above* AMMs — solvers compete off-chain and route unmatched flow through on-chain liquidity, Uniswap included, as a fallback.

| | CoW Protocol | Angstrom | Walras |
|---|---|---|---|
| Layer | Above AMMs — routes through pools as one liquidity source | Inside the pool, as a v4 hook | Inside the pool, as a v4 hook |
| Coverage | Only flow routed through CoW's intent system | Every swap touching the pool | Every swap touching the pool |
| Who runs the auction | Competitive off-chain solver network | Off-chain node network staked into the protocol | Nobody — on-chain, permissionless, deterministic |
| Liveness depends on | Solvers bidding | The node network being live and honest | The next caller to touch the contract |
| Clearing price source | Solver-proposed, competitively enforced | Node-computed off-chain, verified on settlement | Curve/order-book intersection, computed on-chain |

The honest summary: Angstrom buys richer execution (off-chain limit orders, cross-venue liquidity, a dedicated arbitrage auction) at the cost of a trusted, staked operator set. Walras gives up that richness for a mechanism with no operator set at all — nothing to stake, nothing to slash, nothing to be censored by, and no off-chain component that can go down. Whether that trade is worth making is exactly the question this build is testing.

## Why this fits the theme

**MEV protection** is structural rather than routing-based: sandwiching is impossible within an enforced batch, because no swap can execute outside one, and no order in a batch can be advantaged over another by ordering when all of them clear at `P*`.

**Sustainable liquidity** comes from three separate effects that compound: netting means gross toxic flow never reaches the curve; uniform settlement at the marginal price means the arbitrageur's usual price improvement is donated to LPs instead; and netted volume still pays LP fees despite never consuming liquidity. LPs earn on gross volume while carrying inventory risk on net volume only.

## Known limitations

These are real and unresolved, and are called out here rather than left for someone to find.

**Last-submitter advantage.** Orders are submitted in plaintext on-chain into a window that closes deterministically. The last submitter before close sees the entire book and can compute `P*` before committing, which is a free option on the batch. This is the standard failure mode of any batch auction without sealed bids. The two known mitigations — commit-reveal on order contents, or a randomized window close derived from a value not known at submission time — are both compatible with this design but are out of scope for the cohort build. Uniform clearing removes *ordering* MEV; it does not by itself remove *timing* MEV.

**Composability is deliberately sacrificed.** A pool whose `beforeSwap` reverts for every caller but one is invisible to the Universal Router, to aggregators, and to the Uniswap interface. This is the direct cost of making protection pool-level instead of opt-in, and it caps how much liquidity such a pool can realistically attract. Walras is a claim that some pairs are worth trading this way, not that every pool should be.

**Settlement is a single point of failure.** If the settlement path ever reverts, the pool becomes unusable, since nothing else is permitted to swap against it. A circuit breaker that relaxes exclusivity after a sustained settlement failure is part of the hardening section for exactly this reason.

**Concentrated liquidity is priced approximately.** The clearing price solves against a single liquidity value, which is exact for a position spanning the full range but not for one whose liquidity changes at a tick the residual crosses. The solver reports when its answer left the tick the pool started in, so the case is detected rather than silently mispriced. Handling it properly means walking tick boundaries and order limit prices as a combined set of breakpoints, solving the same quadratic within each segment — the same shape as a swap loop, and specified but not built.

**Orders at a limit-price discontinuity are not yet rationed.** A limit price makes eligible volume jump, and the clearing price can land exactly on that jump, where the eligible orders over-supply the batch. The correct response is to fill the marginal order partially — exactly the amount that balances — rather than all of it or none. The solver returns the right price in this case; settlement currently does not ration at it.

**Execution certainty is worse than a spot swap.** Batching means waiting, and a limit price means a batch can fail to fill. That is the inherent trade against continuous trading, not a bug in this implementation.

## Architecture

```
contracts/
├── src/
│   ├── WalrasHook.sol      — beforeSwap exclusivity enforcement, escrow, batch lifecycle
│   ├── libraries/
│   │   ├── Netting.sol       — eligibility, internal matching, residual computation
│   │   └── ClearingPrice.sol — solves batch supply/demand against the curve for P*
│   ├── types/
│   │   └── Order.sol       — the escrowed swap intent, shared by hook and netting
│   └── mocks/
│       └── MockSettler.sol — stands in for the real settlement path in isolated tests
├── test/
│   ├── WalrasHookExclusivity.t.sol
│   ├── WalrasHookOrderEscrow.t.sol
│   ├── WalrasHookBatchLifecycle.t.sol
│   ├── WalrasHookSettlement.t.sol
│   ├── WalrasHookClaims.t.sol
│   ├── Netting.t.sol
│   └── ClearingPrice.t.sol
├── script/                 — deployment scripts (CREATE2 hook mining)
├── lib/                    — v4-core, v4-periphery, forge-std
├── foundry.toml
└── remappings.txt
frontend/                   — batch status and claims (minimal; the mechanism is the deliverable)
```

Contract build is broken into sections, in dependency order:

1. **Hook shell + exclusivity enforcement** — `beforeSwap` rejects any swap whose caller isn't the authorized settler. Validated first as a standalone spike, since every later section depends on this assumption holding. Done, 3/3 tests passing.
2. **Order escrow / intent submission** — pulls input tokens into custody, records intents against the current batch. Done, 15/15 tests passing.
3. **Batch lifecycle management** — a batch's window starts on its first order rather than on the previous batch's close, so an idle pool runs no timer and never accumulates empty batches. The first interaction past the window retires the batch and opens the next; `poke()` lets anyone do this without trading, for pools that go quiet. Whoever triggers the close is recorded, since they are the party section 6 reimburses. Done, 17/17 tests passing.
4. **Order netting engine** — pure matching logic, no pool and no state: which orders are eligible at a candidate price, how much offsets internally, and what imbalance is left over. Netting and pricing are one fixed point — you cannot offset currency0 against currency1 without a price — so this section answers the netting half exactly for a price given to it, and section 5 solves for the price that makes the answer self-consistent. Done, 18/18 tests passing.
5. **Clearing price** — derives `P*` from the intersection of batch orders and the AMM curve. Setting batch excess demand equal to what the curve absorbs gives a quadratic in sqrt-price whose positive root is `P*`, so no oracle appears anywhere and no search is needed in the common case. One equation covers both directions, and it self-checks: a batch already balanced at the pool's price returns that price exactly. Limit prices make eligible volume a step function, so the closed form is iterated until the set of orders eligible at the answer is the set the answer was computed from. Done, 13/13 tests passing.
6. **Residual settlement and LP donation** — ties (1), (4), and (5) together: executes the net residual against the pool via `PoolManager.swap()` gated by the exclusivity check, settles every order at `P*`, donates both the marginal-vs-average surplus and the netted-volume fee to LPs, and pays the settlement bounty out of that same surplus. Closing a batch is O(1) and needs no incentive; settling it is O(n), which is why the bounty lives here rather than with the lifecycle. Reserved payouts are capped at what the batch actually holds, so a shortfall scales every claim on that side equally rather than leaving one unpayable — the effective price stays uniform. Done, 10/10 tests passing.
7. **Payouts / claims** — pull-based withdrawal of settled proceeds. Paying every order out during settlement would make the closing caller's gas scale with batch size and let one failing recipient revert the whole settlement, so proceeds are reserved and withdrawn separately. Anyone may call `claim`; the proceeds go to the order's owner regardless. An order that could not fill — priced out by its own limit, or expired before the close — never entered the netting, so its input comes back whole. Eligibility is judged as of the batch's close, never the present: every deadline is in the past by claim time, and judging against `block.timestamp` there would report the whole batch expired. Done, 12/12 tests passing.
8. **Hardening** — settlement circuit breaker, deadline expiry, zero-residual batches, all-one-direction batches, decimal/token-ordering edge cases, reentrancy.

## Tech stack

- Foundry, Solidity 0.8.26, `v4-core` / `v4-periphery` (v4.0.0)
- Deployed and tested on **Unichain Sepolia** — Uniswap's own L2, already carrying ~$70B of v4's ~$355B cumulative volume despite launching only 9 months ago. Chosen over other L2s for direct ecosystem alignment with the hookathon's primary funder (Uniswap Foundation) and because past UHI hookathon projects have preferentially deployed there.
- No external oracle dependency, by design — see section 5 above.
- No sponsor integrations for this cohort (UHI10 has none).

## Building and testing

```shell
cd contracts
forge build
forge test -vv
```

## Status

Sections 1 through 7 of 8 complete. 87 tests passing. Hardening (8) remains. See the section breakdown above for what's next.

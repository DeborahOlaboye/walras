# Walras

A Uniswap v4 hook that enforces pool-native batch settlement at a uniform clearing price, no swap can execute against a Walras-governed pool outside a settled batch. Ordering-based MEV becomes structurally impossible, offsetting order flow nets away from LP liquidity and the price improvement that a normal AMM swap hands to the trader is redirected to LPs instead.

Built for the [UHI10 Hookathon](https://atrium.academy/uniswap) (theme: *Sustainable Liquidity and MEV Protection*).

## Try it

| | |
|---|---|
| **Live app** | **https://walras.vercel.app** |
| **Demo video** | https://youtu.be/bA0RbmDjmbA |
| **Hook on Uniscan** | [`0x1fd0240c08Cd81f1Affc5e70ff78500e9D0DC080`](https://sepolia.uniscan.xyz/address/0x1fd0240c08cd81f1affc5e70ff78500e9d0dc080) |

Connect any wallet on **Unichain Sepolia** (chain 1301). The app mints you free test
tokens on first visit, so there is nothing to arrange beforehand, place an order, wait
out the 60-second window, and collect.

Two screens are worth going to directly. **Live group** shows a window filling and the
share of it that never reaches pool liquidity. **Proof** routes a real swap through a
standard Uniswap router at the deployed pool and shows the hook rejecting it with
`DirectSwapsDisabled`, a live call, not a recording.

## The problem

MEV extraction remains a $550M+/year problem on Ethereum alone. Even as private-mempool tooling has suppressed easy sandwich attacks, a deeper structural issue persists at the AMM level, LPs are continuously adversely selected by arbitrageurs correcting stale pool prices (loss-versus-rebalancing, "LVR"), which pushes LPs toward wider fees or exit.

The reason LVR is hard to fix from inside an AMM is that a constant-function curve quotes a *stale* price and fills the entire trade along it. An arbitrageur who knows the true price buys at the curve's average price and captures the whole gap between that average and the true price. Every mechanism below exists to close that gap.

## The mechanism

1. **Order submission.** Users submit swap intents (direction, amount, limit price, deadline) to an escrow contract, which takes custody of the input token.

2. **Batch accumulation.** Orders accumulate over a batch window. No external keeper is required, settlement is self-triggering, the next interaction with the contract checks whether the current window has closed and settles the prior batch first. Whoever closes the batch is recorded and paid a share of the settlement surplus that would otherwise go to LPs, so the party carrying the O(n) settlement gas is not left worse off than everyone they settled for.

3. **Netting.** At settlement, opposite-direction orders net against each other directly. Only the unmatched residual, the net imbalance ever touches the pool's actual liquidity.

4. **Price discovery, then residual execution.** `P*`, the price at which batch demand, batch supply and AMM liquidity intersect, is solved in closed form *before* anything touches the pool, from the batch's own orders and the pool's current price and liquidity. The residual is then pushed through the curve as a single exact-input `PoolManager.swap()` with no price limit imposed, because `P*` was derived from this pool's own liquidity and the curve is expected to stop there on its own.

5. **Uniform settlement at `P*`.** Every order in the batch settles at `P*`, netted and residual alike. This is the load-bearing step, and it is what makes the mechanism work:

   - An arbitrageur correcting a stale pool price no longer captures the gap. Their intent is the residual, and it clears at the *post-correction* marginal price rather than the average price along the walk. There is no stale price left to trade against.
   - The pool internally fills the residual at the curve's average price, but Walras charges the residual trader `P*`. The difference — precisely the price improvement a normal AMM swap would have handed the arbitrageur — is retained at settlement and `donate()`d to the pool's LPs.
   - No oracle is involved anywhere. `P*` is a deterministic function of the batch's own orders and the pool's own liquidity, computable on-chain.

6. **LP compensation on netted volume.** Netted orders never touch the curve, so they would otherwise pay LPs nothing while still relying on the pool for price discovery. Walras charges netted volume the pool's own fee rate and donates it to LPs. LPs therefore earn on gross batch volume while bearing inventory risk only on the residual.

   One case falls out of this: a pool with no in-range liquidity cannot receive a `donate()` at all. Rather than strand the surplus in the contract, settlement detects that and returns it to the batch's own traders as a better fill instead.

7. **Exclusivity enforcement.** The hook's `beforeSwap` callback rejects any swap whose caller isn't the authorized settlement path, so no router, aggregator, or direct call can bypass the batch and trade against the pool outside it. This is what makes the protection pool-level rather than opt-in.

8. **Claims.** Settled proceeds are withdrawn via a pull-based `claim()`, so payout gas cost doesn't scale with batch size.

### Who pays for the surplus

Settling at `P*` means the residual trader pays more than a plain AMM swap would have charged them. That is the point, but it raises a fair question, since a large honest order can be the residual just as easily as an arbitrageur can. The mechanism does not need to tell them apart, because batch composition already does.

For a trader submitting size `Q` into a batch with residual `R`:

- **Walras** fills all of `Q` at `P*`, the marginal price after only `R` has walked the curve.
- **A plain AMM** walks the curve for all of `Q`, charging the average over `[0, Q]` — approximately the marginal price at `Q/2`.

So Walras gives the trader the better fill whenever `R < Q/2`: whenever more than half their order nets away. That condition is not a parameter, it is a property of the flow itself.

Uninformed flow is precisely the flow that finds opposing interest in the batch. It nets heavily, contributes little to the residual, and pays **less** than it would on the open curve, the netted portion has no price impact whatsoever. Informed flow is one-directional by construction, that one-directionality is what makes it toxic. It nets poorly, it becomes the residual and it pays `P*` across its full size.

There is no threshold to tune and no intent to detect, which also means there is nothing to game: an order cannot manufacture opposing flow to net against without someone genuinely taking the other side.

The remaining case is a large uninformed order arriving in a thin, one-directional batch. It pays `P*` on full size and is worse off than it would have been on the curve. In that moment it is informationally indistinguishable from an arbitrageur, and no pool-level mechanism can separate the two. The limit price is the protection: if `P*` is worse than the trader will accept, the order simply does not fill and the cost is a missed trade rather than a bad one.

## Prior art, and where Walras differs

Batch auctions with uniform clearing prices are not a new idea, and the two systems that matter here are both in production.

**Angstrom** (Sorella Labs, $7.5M seed led by Paradigm, backed by the Uniswap Foundation) is the closest comparison: a Uniswap v4 hook that clears each block at a single uniform price and returns arbitrage value to LPs. Walras targets the same failure mode by the same broad mechanism. The difference is the trust and liveness model.

**CoW Protocol** proves the batch-auction mechanism works at scale. CoW Swap operates as a layer *above* AMMs, solvers compete off-chain and route unmatched flow through on-chain liquidity, Uniswap included, as a fallback. CoW also ships **CoW AMM**, a pool of its own on Balancer rather than a hook, where solvers bid for the right to rebalance and the executed amounts come out of that off-chain competition. Both halves depend on the same solver network.

| | CoW Protocol | Angstrom | Walras |
|---|---|---|---|
| Layer | CoW Swap above AMMs; CoW AMM a Balancer pool of its own | Inside the pool, as a v4 hook | Inside the pool, as a v4 hook |
| Coverage | Only flow routed through CoW's intent system, or into a CoW AMM pool | Every swap touching the pool | Every swap touching the pool |
| Who runs the auction | Competitive off-chain solver network | Off-chain node network staked into the protocol | Nobody — on-chain, permissionless, deterministic |
| Liveness depends on | Solvers bidding | The node network being live and honest | The next caller to touch the contract |
| Clearing price source | Solver-proposed, competitively enforced | Node-computed off-chain, verified on settlement | Curve/order-book intersection, computed on-chain |

The honest summary: Angstrom buys richer execution (off-chain limit orders, cross-venue liquidity, a dedicated arbitrage auction) at the cost of a trusted, staked operator set. Walras gives up that richness for a mechanism with no operator set at all, nothing to stake, nothing to slash, nothing to be censored by, and no off-chain component that can go down. Whether that trade is worth making is exactly the question this build is testing.

## Why this fits the theme

**MEV protection** is structural rather than routing-based: sandwiching is impossible within an enforced batch, because no swap can execute outside one, and no order in a batch can be advantaged over another by ordering when all of them clear at `P*`.

**Sustainable liquidity** comes from three separate effects that compound: netting means gross toxic flow never reaches the curve; uniform settlement at the marginal price means the arbitrageur's usual price improvement is donated to LPs instead; and netted volume still pays LP fees despite never consuming liquidity. LPs earn on gross volume while carrying inventory risk on net volume only.

## Known limitations

These are real and unresolved, and are called out here rather than left for someone to find.

**Last-submitter advantage.** Orders are submitted in plaintext on-chain into a window that closes deterministically. The last submitter before close sees the entire book and can compute `P*` before committing, which is a free option on the batch. This is the standard failure mode of any batch auction without sealed bids. The two known mitigations — commit-reveal on order contents, or a randomized window close derived from a value not known at submission time — are both compatible with this design but are out of scope for the cohort build. Uniform clearing removes *ordering* MEV; it does not by itself remove *timing* MEV.

**Composability is deliberately sacrificed.** A pool whose `beforeSwap` reverts for every caller but one is invisible to the Universal Router, to aggregators, and to the Uniswap interface. This is the direct cost of making protection pool-level instead of opt-in, and it caps how much liquidity such a pool can realistically attract. Walras is a claim that some pairs are worth trading this way, not that every pool should be.

**A failed settlement costs its batch a turn.** Settlement runs behind a catchable boundary, so a batch that cannot settle is marked failed and refunds every order rather than stranding the escrow or bricking the pool — but those orders do not trade, and have to be resubmitted. Settlement is also capped at a fixed number of orders per batch, so an unusually busy window pushes the overflow into the next batch instead of past the block gas limit.

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
│   ├── WalrasHookHardening.t.sol
│   ├── Netting.t.sol
│   └── ClearingPrice.t.sol
├── script/
│   ├── Deployments.sol         — per-chain v4 addresses and deployment parameters
│   ├── DeployWalrasHook.s.sol  — the hook alone, against an existing PoolManager
│   ├── DeployDemo.s.sol        — tokens, hook, pool and liquidity in one run
│   └── DeploySwapRouter.s.sol  — a stock v4 router, deployed to be rejected
├── lib/                    — v4-core, v4-periphery, forge-std
├── foundry.toml
└── remappings.txt
frontend/
└── src/
    ├── app/                — landing, live group, place order, collect, history, proof
    ├── components/         — shell, header, the netting figure, shared primitives
    ├── hooks/              — pool state, wallet, orders, settled history, writes
    └── lib/                — chain clients, config, formatting, netting in TypeScript
```

`lib/netting.ts` mirrors `Netting.sol` in the same integer arithmetic, so the split the
UI shows while a window is still open agrees with the receipt afterwards rather than
drifting from it.

Contract build is broken into sections, in dependency order:

1. **Hook shell + exclusivity enforcement** — `beforeSwap` rejects any swap whose caller isn't the authorized settler. Validated first as a standalone spike, since every later section depends on this assumption holding. Now that the hook settles its own batches, the positive case is covered by the settlement suite and what remains here is the negative half. Done, 2/2 tests passing.
2. **Order escrow / intent submission** — pulls input tokens into custody, records intents against the current batch. Done, 15/15 tests passing.
3. **Batch lifecycle management** — a batch's window starts on its first order rather than on the previous batch's close, so an idle pool runs no timer and never accumulates empty batches. The first interaction past the window retires the batch and opens the next; `poke()` lets anyone do this without trading, for pools that go quiet. Whoever triggers the close is recorded, since they are the party section 6 reimburses. Done, 17/17 tests passing.
4. **Order netting engine** — pure matching logic, no pool and no state: which orders are eligible at a candidate price, how much offsets internally, and what imbalance is left over. Netting and pricing are one fixed point — you cannot offset currency0 against currency1 without a price — so this section answers the netting half exactly for a price given to it, and section 5 solves for the price that makes the answer self-consistent. Done, 18/18 tests passing.
5. **Clearing price** — derives `P*` from the intersection of batch orders and the AMM curve. Setting batch excess demand equal to what the curve absorbs gives a quadratic in sqrt-price whose positive root is `P*`, so no oracle appears anywhere and no search is needed in the common case. One equation covers both directions, and it self-checks: a batch already balanced at the pool's price returns that price exactly. Limit prices make eligible volume a step function, so the closed form is iterated until the set of orders eligible at the answer is the set the answer was computed from. Done, 13/13 tests passing.
6. **Residual settlement and LP donation** — ties (1), (4), and (5) together: executes the net residual against the pool via `PoolManager.swap()` gated by the exclusivity check, settles every order at `P*`, donates both the marginal-vs-average surplus and the netted-volume fee to LPs, and pays the settlement bounty out of that same surplus. Closing a batch is O(1) and needs no incentive; settling it is O(n), which is why the bounty lives here rather than with the lifecycle. Reserved payouts are capped at what the batch actually holds, so a shortfall scales every claim on that side equally rather than leaving one unpayable — the effective price stays uniform. Done, 10/10 tests passing.
7. **Payouts / claims** — pull-based withdrawal of settled proceeds. Paying every order out during settlement would make the closing caller's gas scale with batch size and let one failing recipient revert the whole settlement, so proceeds are reserved and withdrawn separately. Anyone may call `claim`; the proceeds go to the order's owner regardless. An order that could not fill — priced out by its own limit, or expired before the close — never entered the netting, so its input comes back whole. Eligibility is judged as of the batch's close, never the present: every deadline is in the past by claim time, and judging against `block.timestamp` there would report the whole batch expired. Done, 12/12 tests passing.
8. **Hardening** — a settlement circuit breaker, since exclusivity means a batch that cannot settle would strand its escrow and leave the pool permanently unusable: settlement runs behind a catchable boundary, and a batch that reverts is marked failed and refunds every order instead. Plus a per-batch order cap so settlement cannot be pushed past the block gas limit, rejection of tokens that deliver less than they were asked to move, and a re-entrancy guard on every state-changing entry point. Done, 10/10 tests passing.

## Tech stack

- Foundry, Solidity 0.8.26, `v4-core` / `v4-periphery` (v4.0.0)
- Next.js and viem for the frontend.
- Deployed and tested on **Unichain Sepolia**.

## Building and testing

```shell
cd contracts
forge build
forge test -vv
```

## Deploying

A v4 hook's address is not incidental — its low bits declare which callbacks the
PoolManager will invoke. Walras needs `beforeSwap`, so deployment mines a CREATE2 salt
until it finds an address carrying that flag. The salt is mined against the CREATE2 proxy
rather than against the sender, because the proxy is what actually performs the
deployment; mining against the wrong deployer produces an address whose flags say
something else, and the PoolManager rejects the hook outright.

Stand up a complete demonstrable deployment — two mintable tokens, the hook, a pool it
governs, and full-range liquidity to trade against:

```shell
forge script script/DeployDemo.s.sol --rpc-url unichain_sepolia --broadcast --verify
```

Or deploy just the hook against an existing pool:

```shell
forge script script/DeployWalrasHook.s.sol --rpc-url unichain_sepolia --broadcast --verify
```

Drop `--broadcast` to simulate first; the run prints every address a frontend needs.
Chain-specific addresses and the deployment parameters — batch window, bounty share, order
cap — live in `script/Deployments.sol`.

The batch window is the most consequential of those parameters, and it is set to 60
seconds.

Exclusivity does not depend on it: nothing can trade against the pool outside a batch at
any window length, so there is no ordering advantage to win regardless. What the window
tunes is the second benefit — how much flow finds an opposite order and settles without
touching pool liquidity at all. That needs several orders to share a window, and placing
one costs six to ten seconds of human time reading a wallet prompt. Sixty seconds sits
comfortably above that while staying a wait a trader would accept.

### Live deployment

Unichain Sepolia (chain 1301), all contracts verified on Uniscan:

| | |
|---|---|
| WalrasHook | `0x1fd0240c08Cd81f1Affc5e70ff78500e9D0DC080` |
| WDA (currency0) | `0xb4825389bB57874BF526df276f6f4f13C73cA674` |
| WDB (currency1) | `0xfdF50d778eb0b3c06d30CDDa51996Ce2a710a89D` |
| PoolManager | `0x00B036B58a818B1BC34d502D3fE730Db729e62AC` |
| Liquidity router | `0x66210D5C2F83aD77084e4c79f25956828cE0d344` |
| Swap router (exists to be rejected) | `0x0D19dCd70fDe5c522B17973D5E5Cbd160C6beb0F` |
| poolId | `0x87cc0db91c355694816d3d338ce683302a85d94ffde442837fde5757a6fa07b0` |

Note for anyone redeploying: `forge` 1.8 rewrites `new Contract{salt: …}` in scripts
through a generated helper rather than the CREATE2 factory, so the address `HookMiner`
computes is not where the hook lands and construction reverts with `HookAddressNotValid`.
Deploy with forge 1.2.x until the script is reworked to call the factory directly.

## Status

Complete and live. 97 tests passing, 89.7% line coverage (100% on both libraries), no
compiler warnings.

The contract side is feature-complete: orders escrow, batches open and retire
themselves, netting and the clearing price resolve on-chain with no oracle, the residual
executes once against the curve, LPs are paid on both netted and residual flow, proceeds
are claimable, and a settlement that fails refunds its batch rather than taking the pool
down with it. All five contracts are deployed to Unichain Sepolia and verified on
Uniscan.

The frontend is six screens reading live chain state.

### Observed on the live deployment

A settled group of four orders, two in each direction:

| | |
|---|---|
| Traded directly between users | **67.3%** of the group's volume |
| Reached pool liquidity | 12.56 WDA of 37.00 total |
| Price every order received | 0.96446, identical across all four |

That is the mechanism doing the thing it exists for: most of a group never touches the
curve, and being first or last in it changes nothing.

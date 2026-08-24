// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "@uniswap/v4-core/src/interfaces/external/IERC20Minimal.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

import {Order} from "./types/Order.sol";
import {Netting} from "./libraries/Netting.sol";
import {ClearingPrice} from "./libraries/ClearingPrice.sol";

/// @title WalrasHook
/// @notice A Uniswap v4 hook that enforces pool-native batch settlement with a uniform
/// clearing price. No swap may execute against a Walras-governed pool except through this
/// contract's own settlement path — enforced by `beforeSwap` rejecting any swap whose
/// `sender` is not this contract itself.
/// @dev Built in sections. Implemented so far: exclusivity enforcement (section 1) and
/// order escrow / intent submission (section 2). Batch lifecycle, netting, clearing price,
/// settlement execution, and claims are built on top in later sections.
contract WalrasHook is IHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using SafeTransferLib for ERC20;
    using StateLibrary for IPoolManager;
    using BalanceDeltaLibrary for BalanceDelta;

    /// @notice Thrown when anything other than the PoolManager calls a hook callback.
    error NotPoolManager();

    /// @notice Thrown when a swap attempts to execute against a Walras-governed pool
    /// without going through this contract's own settlement path.
    error DirectSwapsDisabled();

    /// @notice Thrown when a hook callback this contract does not implement is invoked.
    error NotImplemented();

    /// @notice Thrown when an order is submitted against a pool this hook does not govern.
    /// Without this check, orders could be escrowed against a pool whose swaps Walras has
    /// no authority over, leaving the input tokens unsettleable.
    error PoolNotGoverned();

    /// @notice Thrown when an order is submitted with a zero input amount.
    error ZeroAmount();

    /// @notice Thrown when an order is submitted with a deadline at or before the current
    /// block timestamp, which could never be filled.
    error OrderExpired();

    /// @notice Thrown when a limit price falls outside the range the pool can ever reach.
    error InvalidLimitPrice();

    /// @notice Thrown when a native-currency order's `msg.value` does not match `amountIn`.
    error IncorrectNativeValue();

    /// @notice Thrown when an ERC20 order is submitted with a non-zero `msg.value`, which
    /// would otherwise be silently stranded in the contract.
    error UnexpectedNativeValue();

    /// @notice Thrown when the hook is deployed with a zero-length batch window, which
    /// would close every batch in the block it opened and defeat batching entirely.
    error ZeroBatchDuration();

    /// @notice Thrown when the settlement bounty would take an unreasonable share of the
    /// value a settlement produces, which belongs to LPs.
    error BountyTooLarge();

    /// @notice Thrown when proceeds are claimed from a batch that has not settled yet.
    error BatchNotSettled();

    /// @notice Thrown when an order's proceeds have already been withdrawn.
    error AlreadyClaimed();

    /// @dev The bounty exists to cover gas, not to compete with the LP donation for the
    /// surplus. A tenth of it is generous for that purpose.
    uint16 internal constant MAX_SETTLEMENT_BOUNTY_BIPS = 1_000;

    /// @notice Emitted on every accepted order submission.
    event OrderSubmitted(
        PoolId indexed poolId,
        uint256 indexed batchId,
        address indexed owner,
        uint256 orderIndex,
        bool zeroForOne,
        uint128 amountIn,
        uint160 sqrtPriceLimitX96,
        uint64 deadline
    );

    /// @notice Lifecycle state for one batch of one pool.
    /// @param openedAt When the batch's window began — set by its first order, not by the
    /// close of the previous batch, so an idle pool runs no timer and never accumulates
    /// empty batches.
    /// @param closedAt When the window was observed to have elapsed. Zero while open.
    /// @param closedBy Whoever triggered the close, and therefore paid to settle the batch.
    /// Recorded so section 6 can reimburse them out of batch fees.
    /// @param settled Whether settlement has completed. Set in section 6.
    struct Batch {
        uint64 openedAt;
        uint64 closedAt;
        address closedBy;
        bool settled;
    }

    /// @notice Emitted when a batch receives its first order and its window starts.
    event BatchOpened(PoolId indexed poolId, uint256 indexed batchId, uint64 openedAt);

    /// @notice Emitted once a batch has been netted, its residual executed, and its
    /// proceeds reserved for claiming.
    event BatchSettled(
        PoolId indexed poolId,
        uint256 indexed batchId,
        uint160 clearingSqrtPriceX96,
        bool residualZeroForOne,
        uint256 residualAmount,
        uint256 donatedToLps0,
        uint256 donatedToLps1
    );

    /// @notice Emitted when an order's proceeds are withdrawn.
    event OrderClaimed(
        PoolId indexed poolId,
        uint256 indexed batchId,
        address indexed owner,
        uint256 orderIndex,
        Currency currency,
        uint256 amount,
        bool filled
    );

    /// @notice Emitted when an elapsed batch is closed to new orders and handed to
    /// settlement.
    event BatchClosed(
        PoolId indexed poolId, uint256 indexed batchId, address indexed closedBy, uint64 closedAt, uint256 orderCount
    );

    IPoolManager public immutable poolManager;

    /// @notice How long a batch accepts orders once its first order arrives. Immutable:
    /// a mutable window would let it be shortened to a single block, collapsing the batch
    /// back into continuous trading and removing the protection the hook exists to give.
    uint64 public immutable batchDuration;

    /// @notice Share of the value a settlement produces, in basis points, paid to whoever
    /// triggered it. Closing a batch is cheap, but settling one costs gas proportional to
    /// its size, and the caller who happens to arrive first pays all of it on everyone
    /// else's behalf. The bounty comes out of the surplus settlement itself creates, so it
    /// is funded by the mechanism rather than charged to traders separately.
    uint16 public immutable settlementBountyBips;

    /// @notice The batch currently accepting orders, per pool. Advanced by the batch
    /// lifecycle in section 3; until then every order lands in batch 0.
    mapping(PoolId => uint256) public currentBatchId;

    /// @notice Running total of escrowed currency0 awaiting settlement, per pool and
    /// batch. Maintained on submission so that netting (section 4) can compute the batch
    /// residual without a second pass over the order array.
    mapping(PoolId => mapping(uint256 => uint256)) public escrowedZeroForOne;

    /// @notice Running total of escrowed currency1 awaiting settlement, per pool and batch.
    mapping(PoolId => mapping(uint256 => uint256)) public escrowedOneForZero;

    /// @notice What a batch settled at, and how much is reserved for its claimants.
    /// @param sqrtPriceX96 The uniform clearing price `P*` every eligible order settles at.
    /// @param gross0 Currency0 owed to eligible sellers of currency1 at `P*`, before fees.
    /// @param payout0 Currency0 actually reserved for them. Below `gross0` only when the
    /// batch could not cover the full entitlement, in which case claims scale down
    /// proportionally and the effective price stays uniform across every order.
    /// @param gross1 Currency1 owed to eligible sellers of currency0 at `P*`, before fees.
    /// @param payout1 Currency1 actually reserved for them.
    struct Settlement {
        uint160 sqrtPriceX96;
        uint256 gross0;
        uint256 payout0;
        uint256 gross1;
        uint256 payout1;
    }

    /// @notice Lifecycle state per pool and batch.
    mapping(PoolId => mapping(uint256 => Batch)) public batches;

    /// @notice Settlement result per pool and batch, read by claims.
    mapping(PoolId => mapping(uint256 => Settlement)) public settlements;

    /// @notice Whether an order's proceeds have been withdrawn, per pool, batch and index.
    mapping(PoolId => mapping(uint256 => mapping(uint256 => bool))) public claimed;

    mapping(PoolId => mapping(uint256 => Order[])) internal _orders;

    constructor(IPoolManager _poolManager, uint64 _batchDuration, uint16 _settlementBountyBips) {
        if (_batchDuration == 0) revert ZeroBatchDuration();
        if (_settlementBountyBips > MAX_SETTLEMENT_BOUNTY_BIPS) revert BountyTooLarge();
        poolManager = _poolManager;
        batchDuration = _batchDuration;
        settlementBountyBips = _settlementBountyBips;
        Hooks.validateHookPermissions(this, getHookPermissions());
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    /// @notice Only `beforeSwap` is active for this hook. Every other callback is left
    /// unimplemented and will never be invoked by the PoolManager as a result.
    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // --- Order submission (section 2) --------------------------------------------------

    /// @notice Submits a swap intent into the pool's currently open batch, taking custody
    /// of the input token. The order does not execute here — it is settled with the rest
    /// of its batch at a single uniform clearing price, and its proceeds are withdrawn
    /// separately via `claim()` (section 7).
    /// @param key The pool to trade against. Must be governed by this hook.
    /// @param zeroForOne Direction: true sells currency0 for currency1.
    /// @param amountIn Exact input amount to escrow.
    /// @param sqrtPriceLimitX96 Worst clearing price the caller will accept. Pass a value
    /// adjacent to `TickMath.MIN_SQRT_PRICE` / `MAX_SQRT_PRICE` for an effectively
    /// unbounded order.
    /// @param deadline Unix timestamp after which the order may no longer be filled.
    /// @return batchId The batch the order was recorded against.
    /// @return orderIndex The order's position within that batch.
    function submitOrder(
        PoolKey calldata key,
        bool zeroForOne,
        uint128 amountIn,
        uint160 sqrtPriceLimitX96,
        uint64 deadline
    ) external payable returns (uint256 batchId, uint256 orderIndex) {
        if (address(key.hooks) != address(this)) revert PoolNotGoverned();
        if (amountIn == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert OrderExpired();
        if (sqrtPriceLimitX96 <= TickMath.MIN_SQRT_PRICE || sqrtPriceLimitX96 >= TickMath.MAX_SQRT_PRICE) {
            revert InvalidLimitPrice();
        }

        PoolId poolId = key.toId();

        // Any interaction is an opportunity to retire an elapsed batch. Doing this before
        // reading the batch id is what keeps the order out of a window that has already
        // closed — without it, an order submitted late would join a batch it missed.
        _rollIfElapsed(poolId, key);

        batchId = currentBatchId[poolId];
        orderIndex = _orders[poolId][batchId].length;

        if (orderIndex == 0) {
            uint64 openedAt = uint64(block.timestamp);
            batches[poolId][batchId].openedAt = openedAt;
            emit BatchOpened(poolId, batchId, openedAt);
        }

        _orders[poolId][batchId].push(
            Order({
                owner: msg.sender,
                deadline: deadline,
                zeroForOne: zeroForOne,
                sqrtPriceLimitX96: sqrtPriceLimitX96,
                amountIn: amountIn
            })
        );

        if (zeroForOne) {
            escrowedZeroForOne[poolId][batchId] += amountIn;
        } else {
            escrowedOneForZero[poolId][batchId] += amountIn;
        }

        emit OrderSubmitted(
            poolId, batchId, msg.sender, orderIndex, zeroForOne, amountIn, sqrtPriceLimitX96, deadline
        );

        // Interaction last: every storage write above is already committed, so a token
        // with a transfer callback cannot observe a half-recorded order.
        _pullInput(zeroForOne ? key.currency0 : key.currency1, amountIn);
    }

    // --- Batch lifecycle (section 3) ---------------------------------------------------

    /// @notice Retires the pool's current batch if its window has elapsed, without
    /// submitting an order. Settlement is self-triggering — it rides along on whatever
    /// interaction happens next — but a pool that goes quiet has no next interaction, and
    /// its escrowed orders would sit indefinitely. This gives anyone a way to advance the
    /// pool without having to trade to do it.
    function poke(PoolKey calldata key) external returns (bool rolled) {
        if (address(key.hooks) != address(this)) revert PoolNotGoverned();
        return _rollIfElapsed(key.toId(), key);
    }

    /// @notice When the pool's current batch stops accepting orders, or zero if it holds
    /// no orders yet and so has not started its window.
    function currentBatchClosesAt(PoolId poolId) external view returns (uint64) {
        uint64 openedAt = batches[poolId][currentBatchId[poolId]].openedAt;
        return openedAt == 0 ? 0 : openedAt + batchDuration;
    }

    /// @notice Whether the pool's current batch has outlived its window and would be
    /// closed by the next interaction.
    function isCurrentBatchElapsed(PoolId poolId) external view returns (bool) {
        return _hasElapsed(batches[poolId][currentBatchId[poolId]]);
    }

    /// @dev A batch elapses only once it has actually opened. An empty batch has
    /// `openedAt == 0` and runs no timer, so an idle pool never manufactures empty
    /// batches for settlement to walk through.
    function _hasElapsed(Batch storage batch) internal view returns (bool) {
        return batch.openedAt != 0 && block.timestamp >= batch.openedAt + batchDuration;
    }

    /// @notice Closes the current batch and opens the next one if the window has elapsed.
    /// @dev Closing is O(1); the O(n) work is settlement, which section 6 performs inside
    /// `_settleBatch`. `closedBy` is recorded here so section 6 can reimburse whoever
    /// absorbed that cost on everyone else's behalf.
    function _rollIfElapsed(PoolId poolId, PoolKey calldata key) internal returns (bool) {
        uint256 batchId = currentBatchId[poolId];
        Batch storage batch = batches[poolId][batchId];
        if (!_hasElapsed(batch)) return false;

        uint64 closedAt = uint64(block.timestamp);
        batch.closedAt = closedAt;
        batch.closedBy = msg.sender;

        // Advance before settling. Settlement swaps against the pool, which re-enters this
        // contract through `beforeSwap`; leaving the closed batch current during that call
        // would expose a batch that is mid-settlement as though it were still open.
        currentBatchId[poolId] = batchId + 1;

        emit BatchClosed(poolId, batchId, msg.sender, closedAt, _orders[poolId][batchId].length);

        _settleBatch(poolId, batchId, key);
        return true;
    }

    // --- Settlement (section 6) --------------------------------------------------------

    /// @dev Everything the unlock callback needs to settle one batch. Assembled outside the
    /// lock because solving for the price only reads state, and doing it here keeps the
    /// locked section to the parts that actually move value.
    struct SettleCallbackData {
        PoolKey key;
        PoolId poolId;
        uint256 batchId;
        uint160 clearingSqrtPriceX96;
        uint256 eligible0;
        uint256 eligible1;
        Netting.Residual residual;
        address beneficiary;
    }

    /// @dev Nets the batch, executes whatever imbalance is left against the pool, and
    /// reserves the proceeds for claiming — all at one uniform price.
    function _settleBatch(PoolId poolId, uint256 batchId, PoolKey calldata key) internal {
        Order[] storage batchOrders = _orders[poolId][batchId];
        if (batchOrders.length == 0) {
            batches[poolId][batchId].settled = true;
            return;
        }

        (uint160 sqrtPriceCurrentX96,,,) = poolManager.getSlot0(poolId);
        uint128 liquidity = poolManager.getLiquidity(poolId);

        // Eligibility is judged as of the moment the batch closed, not the moment any
        // later call happens to read it. Claims re-derive the same answer from the same
        // timestamp, so a filled order can never look expired after the fact.
        uint64 asOf = batches[poolId][batchId].closedAt;

        (uint160 clearingSqrtPriceX96,) = ClearingPrice.solve(batchOrders, liquidity, sqrtPriceCurrentX96, asOf);
        (uint256 eligible0, uint256 eligible1) = Netting.eligibleVolume(batchOrders, clearingSqrtPriceX96, asOf);

        poolManager.unlock(
            abi.encode(
                SettleCallbackData({
                    key: key,
                    poolId: poolId,
                    batchId: batchId,
                    clearingSqrtPriceX96: clearingSqrtPriceX96,
                    eligible0: eligible0,
                    eligible1: eligible1,
                    residual: Netting.residual(eligible0, eligible1, clearingSqrtPriceX96),
                    beneficiary: batches[poolId][batchId].closedBy
                })
            )
        );

        batches[poolId][batchId].settled = true;
    }

    /// @notice Executes the batch's residual and splits the proceeds.
    /// @dev The only place this contract swaps, and therefore the only caller `beforeSwap`
    /// will accept. Runs in four steps: push the residual through the curve, work out what
    /// the two sides are owed at `P*`, hand the difference to LPs, and reserve the rest for
    /// claims.
    function unlockCallback(bytes calldata raw) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        SettleCallbackData memory data = abi.decode(raw, (SettleCallbackData));

        uint256 output = _executeResidual(data);

        // Whatever the residual did not consume stays behind for the matched orders, and
        // whatever the pool returned joins the currency the other side already brought.
        uint256 available0 = data.residual.zeroForOne ? data.eligible0 - data.residual.amount : data.eligible0 + output;
        uint256 available1 = data.residual.zeroForOne ? data.eligible1 + output : data.eligible1 - data.residual.amount;

        // Sellers of currency1 are owed currency0 at `P*`, and vice versa. Volume that
        // matched internally never consumed pool liquidity and so never paid the pool's
        // fee; charging it here at the pool's own rate is what makes netted flow pay LPs
        // despite never touching the curve.
        uint256 gross0 = Netting.token0For1(data.eligible1, data.clearingSqrtPriceX96);
        uint256 gross1 = Netting.token1For0(data.eligible0, data.clearingSqrtPriceX96);
        uint256 owed0 = _lessFee(gross0, data.residual.matchedZeroForOne, data.key.fee);
        uint256 owed1 = _lessFee(gross1, data.residual.matchedOneForZero, data.key.fee);

        // Never reserve more than the batch actually holds. When the two disagree the
        // shortfall is spread across every claim on that side, so the effective price stays
        // uniform even though it lands slightly off the fee-free `P*`.
        if (owed0 > available0) owed0 = available0;
        if (owed1 > available1) owed1 = available1;

        (uint256 toLps0, uint256 toLps1) = (available0 - owed0, available1 - owed1);

        // A pool with no in-range liquidity cannot receive a donation. Rather than strand
        // the value, it goes back to the traders as a better fill.
        if (poolManager.getLiquidity(data.poolId) == 0) {
            (owed0, owed1) = (available0, available1);
            (toLps0, toLps1) = (0, 0);
        }

        (uint256 bounty0, uint256 bounty1) = _payBounty(data, toLps0, toLps1);
        (toLps0, toLps1) = (toLps0 - bounty0, toLps1 - bounty1);

        _donate(data.key, toLps0, toLps1);

        settlements[data.poolId][data.batchId] =
            Settlement({sqrtPriceX96: data.clearingSqrtPriceX96, gross0: gross0, payout0: owed0, gross1: gross1, payout1: owed1});

        emit BatchSettled(
            data.poolId,
            data.batchId,
            data.clearingSqrtPriceX96,
            data.residual.zeroForOne,
            data.residual.amount,
            toLps0,
            toLps1
        );

        return "";
    }

    /// @dev Pushes the batch's imbalance through the curve as a single exact-input swap.
    /// No price limit is imposed: `P*` was solved from this pool's own liquidity, so the
    /// curve is expected to stop exactly there, and a limit would only turn a disagreement
    /// into a partial fill that the accounting above does not model.
    function _executeResidual(SettleCallbackData memory data) private returns (uint256 output) {
        if (data.residual.amount == 0) return 0;

        BalanceDelta delta = poolManager.swap(
            data.key,
            IPoolManager.SwapParams({
                zeroForOne: data.residual.zeroForOne,
                amountSpecified: -int256(data.residual.amount),
                sqrtPriceLimitX96: data.residual.zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        (Currency paid, Currency received) = data.residual.zeroForOne
            ? (data.key.currency0, data.key.currency1)
            : (data.key.currency1, data.key.currency0);
        (int128 paidDelta, int128 receivedDelta) =
            data.residual.zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());

        _payPool(paid, uint256(uint128(-paidDelta)));
        output = uint256(uint128(receivedDelta));
        poolManager.take(received, address(this), output);
    }

    /// @dev The fee the matched portion would have paid had it gone through the curve.
    function _lessFee(uint256 gross, uint256 matched, uint24 feePips) private pure returns (uint256) {
        uint256 fee = FullMath.mulDiv(matched, feePips, 1_000_000);
        return gross > fee ? gross - fee : 0;
    }

    function _payBounty(SettleCallbackData memory data, uint256 toLps0, uint256 toLps1)
        private
        returns (uint256 bounty0, uint256 bounty1)
    {
        if (settlementBountyBips == 0 || data.beneficiary == address(0)) return (0, 0);

        bounty0 = FullMath.mulDiv(toLps0, settlementBountyBips, 10_000);
        bounty1 = FullMath.mulDiv(toLps1, settlementBountyBips, 10_000);
        if (bounty0 != 0) _transferOut(data.key.currency0, data.beneficiary, bounty0);
        if (bounty1 != 0) _transferOut(data.key.currency1, data.beneficiary, bounty1);
    }

    /// @dev Hands the surplus to the pool's in-range liquidity providers. This is where an
    /// arbitrageur's usual price improvement ends up: the pool filled the residual at the
    /// curve's average price while the trader was charged the marginal price `P*`, and the
    /// gap between them belongs to the LPs who supplied the liquidity.
    function _donate(PoolKey memory key, uint256 amount0, uint256 amount1) private {
        if (amount0 == 0 && amount1 == 0) return;
        poolManager.donate(key, amount0, amount1, "");
        if (amount0 != 0) _payPool(key.currency0, amount0);
        if (amount1 != 0) _payPool(key.currency1, amount1);
    }

    function _payPool(Currency currency, uint256 amount) private {
        if (amount == 0) return;
        if (currency.isAddressZero()) {
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(currency);
            IERC20Minimal(Currency.unwrap(currency)).transfer(address(poolManager), amount);
            poolManager.settle();
        }
    }

    function _transferOut(Currency currency, address to, uint256 amount) private {
        if (amount == 0) return;
        currency.transfer(to, amount);
    }

    // --- Claims (section 7) ------------------------------------------------------------

    /// @notice Withdraws one settled order's proceeds to the address that submitted it.
    /// @dev Pull-based on purpose. Paying every order out during settlement would make the
    /// closing caller's gas scale with batch size and give a single failing recipient the
    /// power to revert the whole settlement. Anyone may call this — the proceeds go to the
    /// order's owner regardless — so a third party can clear a batch's claims on behalf of
    /// its traders.
    /// @return currency The currency paid out.
    /// @return amount How much was paid.
    function claim(PoolKey calldata key, uint256 batchId, uint256 orderIndex)
        external
        returns (Currency currency, uint256 amount)
    {
        if (address(key.hooks) != address(this)) revert PoolNotGoverned();
        PoolId poolId = key.toId();
        if (!batches[poolId][batchId].settled) revert BatchNotSettled();
        if (claimed[poolId][batchId][orderIndex]) revert AlreadyClaimed();

        claimed[poolId][batchId][orderIndex] = true;

        Order memory order = _orders[poolId][batchId][orderIndex];
        bool filled;
        (currency, amount, filled) = _proceeds(key, poolId, batchId, order);

        emit OrderClaimed(poolId, batchId, order.owner, orderIndex, currency, amount, filled);
        _transferOut(currency, order.owner, amount);
    }

    /// @notice What an order would pay out, without withdrawing it.
    /// @return currency The currency the order would receive.
    /// @return amount How much, or zero once already claimed.
    /// @return filled Whether the order traded, as opposed to being refunded unfilled.
    function claimable(PoolKey calldata key, uint256 batchId, uint256 orderIndex)
        external
        view
        returns (Currency currency, uint256 amount, bool filled)
    {
        PoolId poolId = key.toId();
        if (!batches[poolId][batchId].settled) return (CurrencyLibrary.ADDRESS_ZERO, 0, false);

        Order memory order = _orders[poolId][batchId][orderIndex];
        (currency, amount, filled) = _proceeds(key, poolId, batchId, order);
        if (claimed[poolId][batchId][orderIndex]) amount = 0;
    }

    /// @dev An order that could not fill at the clearing price — priced out by its own
    /// limit, or expired before the batch closed — never entered the netting, so its input
    /// was never spent and comes back whole.
    ///
    /// An order that did fill is paid its share of what the batch reserved for its side.
    /// The share is pro-rata against the side's gross entitlement rather than paid in full,
    /// because settlement caps reserves at what it actually holds. Scaling every claim by
    /// the same ratio is what keeps the realised price uniform across the batch when the
    /// pool's swap fee leaves the side slightly short of the fee-free `P*`.
    function _proceeds(PoolKey calldata key, PoolId poolId, uint256 batchId, Order memory order)
        private
        view
        returns (Currency currency, uint256 amount, bool filled)
    {
        Settlement memory settlement = settlements[poolId][batchId];

        if (!Netting.isEligible(order, settlement.sqrtPriceX96, batches[poolId][batchId].closedAt)) {
            return (order.zeroForOne ? key.currency0 : key.currency1, order.amountIn, false);
        }

        if (order.zeroForOne) {
            uint256 entitlement = Netting.token1For0(order.amountIn, settlement.sqrtPriceX96);
            amount = settlement.gross1 == 0 ? 0 : FullMath.mulDiv(entitlement, settlement.payout1, settlement.gross1);
            return (key.currency1, amount, true);
        }

        uint256 owed = Netting.token0For1(order.amountIn, settlement.sqrtPriceX96);
        amount = settlement.gross0 == 0 ? 0 : FullMath.mulDiv(owed, settlement.payout0, settlement.gross0);
        return (key.currency0, amount, true);
    }

    /// @notice Number of orders recorded against a given batch.
    function orderCount(PoolId poolId, uint256 batchId) external view returns (uint256) {
        return _orders[poolId][batchId].length;
    }

    /// @notice Reads a single order out of a batch.
    function getOrder(PoolId poolId, uint256 batchId, uint256 index) external view returns (Order memory) {
        return _orders[poolId][batchId][index];
    }

    /// @notice Takes custody of an order's input amount. Native currency arrives as
    /// `msg.value`; everything else is pulled by `transferFrom`, which requires the caller
    /// to have approved this contract first.
    /// @dev Fee-on-transfer and rebasing tokens deliver less than `amountIn` and would
    /// leave the escrow totals overstated. Rejecting them is part of section 8.
    function _pullInput(Currency currency, uint128 amountIn) internal {
        if (currency.isAddressZero()) {
            if (msg.value != amountIn) revert IncorrectNativeValue();
        } else {
            if (msg.value != 0) revert UnexpectedNativeValue();
            ERC20(Currency.unwrap(currency)).safeTransferFrom(msg.sender, address(this), amountIn);
        }
    }

    // --- Hook callbacks ----------------------------------------------------------------

    /// @notice Rejects any swap that did not originate from this contract's own
    /// settlement path. `sender` is the address that called `PoolManager.swap` directly,
    /// which for a Walras-governed pool is only ever this contract settling a batch.
    /// Everything else — routers, aggregators, direct calls — reverts here.
    function beforeSwap(address sender, PoolKey calldata, IPoolManager.SwapParams calldata, bytes calldata)
        external
        view
        override
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (sender != address(this)) revert DirectSwapsDisabled();
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    // --- Unimplemented callbacks -------------------------------------------------------
    // Permission flags above are all false for these, so the PoolManager will never call
    // them. They exist only to satisfy the IHooks interface.

    function beforeInitialize(address, PoolKey calldata, uint160) external pure override returns (bytes4) {
        revert NotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure override returns (bytes4) {
        revert NotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert NotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert NotImplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure override returns (bytes4) {
        revert NotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert NotImplemented();
    }

    function afterSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        override
        returns (bytes4, int128)
    {
        revert NotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert NotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert NotImplemented();
    }
}

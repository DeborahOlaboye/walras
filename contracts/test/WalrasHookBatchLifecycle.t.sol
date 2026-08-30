// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {WalrasHook} from "../src/WalrasHook.sol";

/// @notice Section 3: batch lifecycle. The claim under test is that Walras needs no
/// keeper — that a batch retires itself on whatever interaction happens next, and that a
/// pool nobody is trading can still be advanced by anyone. These tests also pin the two
/// properties settlement will depend on: a closed batch keeps its orders and its escrow
/// intact, and batches never bleed into one another.
contract WalrasHookBatchLifecycleTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    WalrasHook internal hook;
    PoolId internal poolId;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint64 internal constant BATCH_DURATION = 60;
    uint16 internal constant BOUNTY_BIPS = 500;
    uint16 internal constant MAX_ORDERS = 64;

    /// @dev Tests that warp must anchor on a literal rather than caching
    /// `block.timestamp` in a local. Under `via_ir` the optimizer treats TIMESTAMP as
    /// constant within a call and folds such a local back into a fresh read, so the
    /// "start" value silently tracks each `vm.warp` instead of holding still.
    uint256 internal constant T0 = 1_000_000;
    uint64 internal constant DEADLINE = 1 days;

    event BatchOpened(PoolId indexed poolId, uint256 indexed batchId, uint64 openedAt);
    event BatchClosed(
        PoolId indexed poolId, uint256 indexed batchId, address indexed closedBy, uint64 closedAt, uint256 orderCount
    );

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
        bytes memory constructorArgs = abi.encode(manager, BATCH_DURATION, BOUNTY_BIPS, MAX_ORDERS);
        (address hookAddress, bytes32 salt) =
            HookMiner.find(address(this), flags, type(WalrasHook).creationCode, constructorArgs);

        hook = new WalrasHook{salt: salt}(manager, BATCH_DURATION, BOUNTY_BIPS, MAX_ORDERS);
        require(address(hook) == hookAddress, "hook address mismatch");

        (key,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1);
        poolId = key.toId();

        _fundAndApprove(alice);
        _fundAndApprove(bob);
        _fundAndApprove(carol);
    }

    function _fundAndApprove(address who) internal {
        MockERC20(Currency.unwrap(currency0)).mint(who, 1_000 ether);
        MockERC20(Currency.unwrap(currency1)).mint(who, 1_000 ether);
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(hook), type(uint256).max);
        vm.stopPrank();
    }

    function _submit(address who, bool zeroForOne, uint128 amountIn) internal returns (uint256 batchId) {
        vm.prank(who);
        (batchId,) = hook.submitOrder(
            key,
            zeroForOne,
            amountIn,
            zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT,
            uint64(block.timestamp) + DEADLINE
        );
    }

    function _openedAt(uint256 batchId) internal view returns (uint64 openedAt) {
        (openedAt,,,,) = hook.batches(poolId, batchId);
    }

    function _closedAt(uint256 batchId) internal view returns (uint64 closedAt) {
        (, closedAt,,,) = hook.batches(poolId, batchId);
    }

    function _closedBy(uint256 batchId) internal view returns (address closedBy) {
        (,, closedBy,,) = hook.batches(poolId, batchId);
    }

    // --- Window start ------------------------------------------------------------------

    /// @notice The window is started by the batch's first order, not by the close of the
    /// batch before it. This is what stops an idle pool from running a timer.
    function test_FirstOrderStartsTheWindow() public {
        assertEq(_openedAt(0), 0, "window running before any order");

        vm.expectEmit(true, true, false, true, address(hook));
        emit BatchOpened(poolId, 0, uint64(block.timestamp));
        _submit(alice, true, 1 ether);

        assertEq(_openedAt(0), uint64(block.timestamp), "window not started");
        assertEq(hook.currentBatchClosesAt(poolId), uint64(block.timestamp) + BATCH_DURATION, "close time");
    }

    /// @notice Later orders join the window in progress; they must not extend it, or a
    /// steady trickle of orders would keep a batch open forever.
    function test_SubsequentOrdersDoNotExtendTheWindow() public {
        _submit(alice, true, 1 ether);
        uint64 openedAt = _openedAt(0);

        vm.warp(block.timestamp + 30);
        _submit(bob, false, 1 ether);

        assertEq(_openedAt(0), openedAt, "window restarted");
        assertEq(hook.currentBatchClosesAt(poolId), openedAt + BATCH_DURATION, "close time moved");
    }

    /// @notice An empty batch has no window, so no amount of elapsed time makes it
    /// eligible to close. Without this, a quiet pool would manufacture empty batches for
    /// settlement to walk through.
    function test_EmptyBatchNeverElapses() public {
        vm.warp(block.timestamp + 10 days);

        assertFalse(hook.isCurrentBatchElapsed(poolId), "empty batch elapsed");
        assertEq(hook.currentBatchClosesAt(poolId), 0, "empty batch has a close time");

        assertFalse(hook.poke(key), "poke rolled an empty batch");
        assertEq(hook.currentBatchId(poolId), 0, "batch advanced");
    }

    // --- Rolling -----------------------------------------------------------------------

    function test_OrderWithinWindowJoinsSameBatch() public {
        assertEq(_submit(alice, true, 1 ether), 0, "first order batch");

        vm.warp(block.timestamp + BATCH_DURATION - 1);

        assertFalse(hook.isCurrentBatchElapsed(poolId), "elapsed early");
        assertEq(_submit(bob, false, 1 ether), 0, "second order left the batch");
    }

    /// @notice The window closes the instant it is reached, not a second later.
    function test_WindowClosesAtExactBoundary() public {
        _submit(alice, true, 1 ether);
        vm.warp(block.timestamp + BATCH_DURATION);

        assertTrue(hook.isCurrentBatchElapsed(poolId), "not elapsed at boundary");
        assertEq(_submit(bob, false, 1 ether), 1, "did not roll at boundary");
    }

    /// @notice The core self-triggering claim: an order arriving after the window has
    /// elapsed retires the previous batch on its way in, and lands in a fresh one.
    function test_OrderAfterWindowRollsToNextBatch() public {
        _submit(alice, true, 1 ether);
        vm.warp(block.timestamp + BATCH_DURATION + 1);

        vm.expectEmit(true, true, true, true, address(hook));
        emit BatchClosed(poolId, 0, bob, uint64(block.timestamp), 1);

        assertEq(_submit(bob, false, 2 ether), 1, "did not roll");
        assertEq(hook.currentBatchId(poolId), 1, "current batch");
        assertEq(_closedAt(0), uint64(block.timestamp), "closedAt");
        assertEq(_closedBy(0), bob, "closedBy");
    }

    /// @notice Whoever triggers the roll is recorded as having done so, since they are the
    /// party section 6 reimburses for absorbing the settlement cost.
    function test_RollAttributesClosureToTheTriggeringCaller() public {
        _submit(alice, true, 1 ether);
        vm.warp(block.timestamp + BATCH_DURATION + 1);

        vm.prank(carol);
        hook.poke(key);

        assertEq(_closedBy(0), carol, "closer not attributed");
    }

    // --- Poke --------------------------------------------------------------------------

    /// @notice A pool that goes quiet has no next interaction to ride on. Poke exists so
    /// advancing it does not require trading against it.
    function test_PokeClosesElapsedBatchWithoutAnOrder() public {
        _submit(alice, true, 1 ether);
        vm.warp(block.timestamp + BATCH_DURATION + 1);

        assertTrue(hook.poke(key), "poke did not roll");
        assertEq(hook.currentBatchId(poolId), 1, "batch not advanced");
        assertEq(hook.orderCount(poolId, 1), 0, "new batch not empty");
    }

    /// @notice Poking mid-window must not truncate the batch early.
    function test_PokeIsNoOpWithinWindow() public {
        _submit(alice, true, 1 ether);
        vm.warp(block.timestamp + BATCH_DURATION - 1);

        assertFalse(hook.poke(key), "poke rolled early");
        assertEq(hook.currentBatchId(poolId), 0, "batch advanced early");
        assertEq(_closedAt(0), 0, "batch marked closed");
    }

    /// @notice A batch rolled by poke rather than by an order starts no window of its own
    /// until an order actually arrives.
    function test_BatchRolledByPokeStaysUnopened() public {
        _submit(alice, true, 1 ether);
        vm.warp(block.timestamp + BATCH_DURATION + 1);
        hook.poke(key);

        assertEq(_openedAt(1), 0, "window started with no orders");

        vm.warp(block.timestamp + 10 days);
        assertFalse(hook.isCurrentBatchElapsed(poolId), "unopened batch elapsed");
    }

    function test_PokeRevertsOnUngovernedPool() public {
        PoolKey memory foreign = PoolKey({
            currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(0))
        });

        vm.expectRevert(WalrasHook.PoolNotGoverned.selector);
        hook.poke(foreign);
    }

    // --- Isolation between batches -----------------------------------------------------

    /// @notice Escrow totals are what section 4 nets against. If they leaked across a
    /// roll, a settled batch would net against orders that were never part of it.
    function test_EscrowTotalsAreSegregatedPerBatch() public {
        _submit(alice, true, 4 ether);
        _submit(bob, false, 1 ether);
        vm.warp(block.timestamp + BATCH_DURATION + 1);
        _submit(carol, true, 9 ether);

        assertEq(hook.escrowedZeroForOne(poolId, 0), 4 ether, "batch 0 zeroForOne");
        assertEq(hook.escrowedOneForZero(poolId, 0), 1 ether, "batch 0 oneForZero");
        assertEq(hook.escrowedZeroForOne(poolId, 1), 9 ether, "batch 1 zeroForOne");
        assertEq(hook.escrowedOneForZero(poolId, 1), 0, "batch 1 oneForZero");
    }

    /// @notice Closing a batch must not disturb the orders inside it — settlement has not
    /// run yet and still needs every one of them.
    function test_ClosedBatchRetainsItsOrders() public {
        _submit(alice, true, 4 ether);
        _submit(bob, false, 1 ether);
        vm.warp(block.timestamp + BATCH_DURATION + 1);
        hook.poke(key);

        assertEq(hook.orderCount(poolId, 0), 2, "orders lost on close");
        assertEq(hook.getOrder(poolId, 0, 0).owner, alice, "order 0 owner");
        assertEq(hook.getOrder(poolId, 0, 1).owner, bob, "order 1 owner");
    }

    /// @notice Closing and settling are one atomic step: the interaction that retires a
    /// batch also nets it and executes its residual. The two are tracked separately anyway,
    /// because section 8's circuit breaker needs to recognise a batch that closed but whose
    /// settlement reverted.
    function test_ClosingABatchSettlesIt() public {
        _submit(alice, true, 1 ether);
        vm.warp(block.timestamp + BATCH_DURATION + 1);
        hook.poke(key);

        (, uint64 closedAt,, bool settled,) = hook.batches(poolId, 0);
        assertGt(closedAt, 0, "batch not closed");
        assertTrue(settled, "closed batch left unsettled");
    }

    /// @notice Several idle windows in a row must not skip batches: each roll advances by
    /// exactly one, because only the batch that actually holds orders has a window.
    function test_LongIdlePeriodAdvancesExactlyOneBatch() public {
        _submit(alice, true, 1 ether);
        vm.warp(block.timestamp + 10 * BATCH_DURATION);
        hook.poke(key);

        assertEq(hook.currentBatchId(poolId), 1, "skipped batches");
    }

    // --- Configuration -----------------------------------------------------------------

    /// @notice A zero-length window would close every batch in the block it opened,
    /// collapsing batching back into continuous trading.
    function test_RevertsOnZeroBatchDuration() public {
        vm.expectRevert(WalrasHook.ZeroBatchDuration.selector);
        new WalrasHook(IPoolManager(address(manager)), 0, BOUNTY_BIPS, MAX_ORDERS);
    }

    /// @notice Regardless of how orders are spread through a window, they belong to
    /// exactly one batch, and the roll happens on the first interaction past the boundary.
    function testFuzz_OrdersLandInTheBatchTheirTimestampImplies(uint32 firstGap, uint32 secondGap) public {
        firstGap = uint32(bound(firstGap, 0, BATCH_DURATION - 1));
        secondGap = uint32(bound(secondGap, 0, 5 * BATCH_DURATION));

        vm.warp(T0);
        _submit(alice, true, 1 ether);

        vm.warp(T0 + firstGap);
        assertEq(_submit(bob, false, 1 ether), 0, "second order left batch 0");

        vm.warp(T0 + firstGap + secondGap);
        uint256 expected = uint256(firstGap) + uint256(secondGap) >= BATCH_DURATION ? 1 : 0;
        assertEq(_submit(carol, true, 1 ether), expected, "third order in wrong batch");
    }
}

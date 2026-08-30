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

/// @notice Section 7: claims. Settlement reserves proceeds; this is how they leave the
/// contract. The properties that matter are that every filled order realises the same
/// price, that an order which could not fill gets its input back untouched, and that the
/// contract never pays out more than it holds.
contract WalrasHookClaimsTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    WalrasHook internal hook;
    PoolId internal poolId;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal relayer = makeAddr("relayer");

    uint64 internal constant BATCH_DURATION = 60;
    uint16 internal constant BOUNTY_BIPS = 500;
    uint16 internal constant MAX_ORDERS = 64;
    uint64 internal constant DEADLINE = 1 days;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
        bytes memory constructorArgs = abi.encode(manager, BATCH_DURATION, BOUNTY_BIPS, MAX_ORDERS);
        (address hookAddress, bytes32 salt) =
            HookMiner.find(address(this), flags, type(WalrasHook).creationCode, constructorArgs);

        hook = new WalrasHook{salt: salt}(manager, BATCH_DURATION, BOUNTY_BIPS, MAX_ORDERS);
        require(address(hook) == hookAddress, "hook address mismatch");

        key = PoolKey(currency0, currency1, 3000, 60, IHooks(address(hook)));
        manager.initialize(key, SQRT_PRICE_1_1);
        poolId = key.toId();

        modifyLiquidityRouter.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({tickLower: -887220, tickUpper: 887220, liquidityDelta: 1e21, salt: 0}),
            ""
        );

        _fundAndApprove(alice);
        _fundAndApprove(bob);
        _fundAndApprove(carol);
    }

    function _fundAndApprove(address who) internal {
        MockERC20(Currency.unwrap(currency0)).mint(who, 10_000 ether);
        MockERC20(Currency.unwrap(currency1)).mint(who, 10_000 ether);
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(hook), type(uint256).max);
        vm.stopPrank();
    }

    function _submit(address who, bool zeroForOne, uint128 amountIn) internal returns (uint256 index) {
        return _submitWith(who, zeroForOne, amountIn, zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT, DEADLINE);
    }

    function _submitWith(address who, bool zeroForOne, uint128 amountIn, uint160 limit, uint64 lifetime)
        internal
        returns (uint256 index)
    {
        vm.prank(who);
        (, index) = hook.submitOrder(key, zeroForOne, amountIn, limit, uint64(block.timestamp) + lifetime);
    }

    function _settle() internal {
        vm.warp(block.timestamp + BATCH_DURATION + 1);
        vm.prank(relayer);
        hook.poke(key);
    }

    function _balance0(address who) internal view returns (uint256) {
        return MockERC20(Currency.unwrap(currency0)).balanceOf(who);
    }

    function _balance1(address who) internal view returns (uint256) {
        return MockERC20(Currency.unwrap(currency1)).balanceOf(who);
    }

    // --- Filled orders -----------------------------------------------------------------

    /// @notice A seller of currency0 walks away holding currency1, and vice versa.
    function test_FilledOrdersReceiveTheOppositeCurrency() public {
        uint256 aliceIndex = _submit(alice, true, 1 ether);
        uint256 bobIndex = _submit(bob, false, 1 ether);
        _settle();

        uint256 aliceBefore = _balance1(alice);
        uint256 bobBefore = _balance0(bob);

        hook.claim(key, 0, aliceIndex);
        hook.claim(key, 0, bobIndex);

        assertGt(_balance1(alice), aliceBefore, "seller of currency0 received no currency1");
        assertGt(_balance0(bob), bobBefore, "seller of currency1 received no currency0");
    }

    /// @notice The definition of a uniform clearing price: two orders on the same side, of
    /// different sizes, must realise exactly the same rate. Nobody in the batch is filled
    /// better or worse than anybody else.
    function test_EveryOrderOnASideRealisesTheSamePrice() public {
        uint256 smallIndex = _submit(alice, true, 1 ether);
        uint256 largeIndex = _submit(bob, true, 3 ether);
        _submit(carol, false, 4 ether);
        _settle();

        (, uint256 smallOut,) = hook.claimable(key, 0, smallIndex);
        (, uint256 largeOut,) = hook.claimable(key, 0, largeIndex);

        assertGt(smallOut, 0, "small order got nothing");
        assertApproxEqRel(smallOut * 3, largeOut, 1e12, "orders on the same side realised different prices");
    }

    /// @notice Proceeds always go to the order's owner, so a third party can settle a
    /// batch's claims without being able to redirect them.
    function test_AnyoneMayClaimButProceedsGoToTheOwner() public {
        uint256 index = _submit(alice, true, 1 ether);
        _submit(bob, false, 1 ether);
        _settle();

        uint256 aliceBefore = _balance1(alice);
        uint256 relayerBefore = _balance1(relayer);

        vm.prank(relayer);
        hook.claim(key, 0, index);

        assertGt(_balance1(alice), aliceBefore, "owner not paid");
        assertEq(_balance1(relayer), relayerBefore, "claimer paid themselves");
    }

    // --- Unfilled orders ---------------------------------------------------------------

    /// @notice An order priced out by its own limit never entered the netting, so its input
    /// was never spent and comes back whole — in the currency it was posted in.
    function test_PricedOutOrderIsRefundedItsInput() public {
        // A large seller of currency0 insisting on a floor at parity cannot be part of any
        // price it would itself create, so it drops out of the batch entirely.
        uint256 index = _submitWith(alice, true, 50 ether, SQRT_PRICE_1_1, DEADLINE);
        _submit(bob, false, 1 ether);
        _settle();

        uint256 before = _balance0(alice);
        (Currency currency, uint256 amount, bool filled) = hook.claimable(key, 0, index);

        assertFalse(filled, "priced-out order reported as filled");
        assertEq(Currency.unwrap(currency), Currency.unwrap(currency0), "refunded in the wrong currency");
        assertEq(amount, 50 ether, "refund was not the full input");

        hook.claim(key, 0, index);
        assertEq(_balance0(alice), before + 50 ether, "refund not paid");
    }

    /// @notice An order whose deadline passed before the batch closed is refunded, not
    /// filled — and crucially, judged against the close, not against whenever the claim
    /// happens to be made.
    function test_OrderExpiringBeforeTheCloseIsRefunded() public {
        uint256 index = _submitWith(alice, true, 2 ether, MIN_PRICE_LIMIT, 10);
        _submit(bob, false, 1 ether);
        _settle();

        (Currency currency, uint256 amount, bool filled) = hook.claimable(key, 0, index);
        assertFalse(filled, "expired order was filled");
        assertEq(Currency.unwrap(currency), Currency.unwrap(currency0), "wrong refund currency");
        assertEq(amount, 2 ether, "expired order not refunded in full");
    }

    /// @notice The regression that motivated recording the close time: every deadline is in
    /// the past by the time anyone claims, so eligibility judged at claim time would report
    /// the whole batch expired and refund orders that had in fact traded.
    function test_FilledOrderStaysFilledLongAfterItsDeadline() public {
        uint256 index = _submit(alice, true, 1 ether);
        _submit(bob, false, 1 ether);
        _settle();

        vm.warp(block.timestamp + 365 days);

        (, uint256 amount, bool filled) = hook.claimable(key, 0, index);
        assertTrue(filled, "filled order reported unfilled after its deadline passed");
        assertGt(amount, 0, "filled order paid nothing");
    }

    // --- Guards ------------------------------------------------------------------------

    function test_RevertsBeforeTheBatchHasSettled() public {
        uint256 index = _submit(alice, true, 1 ether);

        vm.expectRevert(WalrasHook.BatchNotSettled.selector);
        hook.claim(key, 0, index);
    }

    function test_RevertsOnSecondClaim() public {
        uint256 index = _submit(alice, true, 1 ether);
        _submit(bob, false, 1 ether);
        _settle();

        hook.claim(key, 0, index);

        vm.expectRevert(WalrasHook.AlreadyClaimed.selector);
        hook.claim(key, 0, index);
    }

    function test_ClaimableReportsNothingOnceClaimed() public {
        uint256 index = _submit(alice, true, 1 ether);
        _submit(bob, false, 1 ether);
        _settle();

        (, uint256 beforeClaim,) = hook.claimable(key, 0, index);
        hook.claim(key, 0, index);
        (, uint256 afterClaim,) = hook.claimable(key, 0, index);

        assertGt(beforeClaim, 0, "nothing claimable to begin with");
        assertEq(afterClaim, 0, "still reported as claimable");
    }

    function test_RevertsOnUngovernedPool() public {
        PoolKey memory foreign = PoolKey({
            currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(0))
        });

        vm.expectRevert(WalrasHook.PoolNotGoverned.selector);
        hook.claim(foreign, 0, 0);
    }

    /// @notice The view must agree with what the transfer actually pays, or a frontend
    /// showing it would be lying.
    function test_ClaimableAgreesWithClaim() public {
        uint256 index = _submit(alice, true, 3 ether);
        _submit(bob, false, 2 ether);
        _settle();

        (, uint256 quoted,) = hook.claimable(key, 0, index);
        uint256 before = _balance1(alice);
        hook.claim(key, 0, index);

        assertEq(_balance1(alice) - before, quoted, "quote did not match the payout");
    }

    // --- Solvency ----------------------------------------------------------------------

    /// @notice The invariant the whole design rests on: every order in a batch can be paid
    /// out of what the contract actually holds. Refunds and fills together must never
    /// exceed it.
    function testFuzz_EveryOrderInABatchCanBePaid(uint128 rawA, uint128 rawB, uint128 rawC) public {
        uint128 a = uint128(bound(rawA, 0.01 ether, 100 ether));
        uint128 b = uint128(bound(rawB, 0.01 ether, 100 ether));
        uint128 c = uint128(bound(rawC, 0.01 ether, 100 ether));

        uint256 i0 = _submit(alice, true, a);
        uint256 i1 = _submit(bob, false, b);
        uint256 i2 = _submitWith(carol, true, c, SQRT_PRICE_1_1, DEADLINE);
        _settle();

        // Each claim must succeed on its own terms; a shortfall would revert on transfer.
        hook.claim(key, 0, i0);
        hook.claim(key, 0, i1);
        hook.claim(key, 0, i2);
    }
}

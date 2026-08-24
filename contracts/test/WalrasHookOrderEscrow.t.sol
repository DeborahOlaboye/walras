// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {WalrasHook} from "../src/WalrasHook.sol";
import {Order} from "../src/types/Order.sol";

/// @notice Section 2: order escrow and intent submission. These tests establish the
/// invariant every later section depends on — that for any batch, the tokens this contract
/// holds match the escrow totals it reports, and that no order is ever recorded without its
/// input being taken into custody first.
contract WalrasHookOrderEscrowTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    WalrasHook internal hook;
    PoolId internal poolId;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint64 internal constant DEADLINE = 1 days;

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

    /// @dev Short enough to warp past in a test, long enough that ordinary
    /// submissions in the same block never trip a roll.
    uint64 internal constant BATCH_DURATION = 60;
    uint16 internal constant BOUNTY_BIPS = 500;
    uint16 internal constant MAX_ORDERS = 64;

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
    }

    function _fundAndApprove(address who) internal {
        MockERC20(Currency.unwrap(currency0)).mint(who, 1_000 ether);
        MockERC20(Currency.unwrap(currency1)).mint(who, 1_000 ether);
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(hook), type(uint256).max);
        vm.stopPrank();
    }

    function _submit(address who, bool zeroForOne, uint128 amountIn) internal returns (uint256, uint256) {
        vm.prank(who);
        return hook.submitOrder(
            key, zeroForOne, amountIn, zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT, uint64(block.timestamp) + DEADLINE
        );
    }

    // --- Custody -----------------------------------------------------------------------

    /// @notice The input token must actually leave the submitter and land in the hook.
    /// An intent recorded without custody is an intent that cannot be settled.
    function test_SubmitOrder_TakesCustodyOfInput() public {
        uint256 aliceBefore = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);

        _submit(alice, true, 5 ether);

        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(alice), aliceBefore - 5 ether, "not debited");
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(address(hook)), 5 ether, "hook not credited");
    }

    /// @notice Direction selects which of the pool's two currencies is escrowed.
    function test_SubmitOrder_OneForZeroEscrowsCurrency1() public {
        _submit(alice, false, 3 ether);

        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(address(hook)), 3 ether, "currency1 not escrowed");
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(address(hook)), 0, "currency0 wrongly touched");
    }

    // --- Recording ---------------------------------------------------------------------

    function test_SubmitOrder_RecordsIntentFaithfully() public {
        uint64 deadline = uint64(block.timestamp) + DEADLINE;

        vm.prank(alice);
        (uint256 batchId, uint256 orderIndex) = hook.submitOrder(key, true, 7 ether, MIN_PRICE_LIMIT, deadline);

        Order memory order = hook.getOrder(poolId, batchId, orderIndex);
        assertEq(order.owner, alice, "owner");
        assertEq(order.amountIn, 7 ether, "amountIn");
        assertEq(order.sqrtPriceLimitX96, MIN_PRICE_LIMIT, "limit");
        assertEq(order.deadline, deadline, "deadline");
        assertTrue(order.zeroForOne, "direction");
    }

    /// @notice Indices must be dense and sequential — netting (section 4) iterates them.
    function test_SubmitOrder_AssignsSequentialIndices() public {
        (uint256 batchId0, uint256 index0) = _submit(alice, true, 1 ether);
        (uint256 batchId1, uint256 index1) = _submit(bob, false, 1 ether);
        (uint256 batchId2, uint256 index2) = _submit(alice, true, 1 ether);

        assertEq(batchId0, 0, "batch 0");
        assertEq(batchId1, 0, "batch still 0");
        assertEq(batchId2, 0, "batch still 0");
        assertEq(index0, 0, "index 0");
        assertEq(index1, 1, "index 1");
        assertEq(index2, 2, "index 2");
        assertEq(hook.orderCount(poolId, 0), 3, "count");
    }

    /// @notice The running totals are what section 4 nets against, so they must track
    /// each direction independently rather than as a single sum.
    function test_SubmitOrder_AccumulatesEscrowPerDirection() public {
        _submit(alice, true, 4 ether);
        _submit(bob, true, 6 ether);
        _submit(bob, false, 2 ether);

        assertEq(hook.escrowedZeroForOne(poolId, 0), 10 ether, "zeroForOne total");
        assertEq(hook.escrowedOneForZero(poolId, 0), 2 ether, "oneForZero total");
    }

    function test_SubmitOrder_EmitsOrderSubmitted() public {
        uint64 deadline = uint64(block.timestamp) + DEADLINE;

        vm.expectEmit(true, true, true, true, address(hook));
        emit OrderSubmitted(poolId, 0, alice, 0, true, 2 ether, MIN_PRICE_LIMIT, deadline);

        vm.prank(alice);
        hook.submitOrder(key, true, 2 ether, MIN_PRICE_LIMIT, deadline);
    }

    // --- Native currency ---------------------------------------------------------------

    /// @notice A native-currency pool escrows via `msg.value` rather than `transferFrom`.
    /// The pool need not be initialized for submission to be valid — only governed.
    function _nativeKey() internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: currency1,
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    function test_SubmitOrder_EscrowsNativeValue() public {
        PoolKey memory nativeKey = _nativeKey();
        vm.deal(alice, 10 ether);

        vm.prank(alice);
        hook.submitOrder{value: 4 ether}(
            nativeKey, true, 4 ether, MIN_PRICE_LIMIT, uint64(block.timestamp) + DEADLINE
        );

        assertEq(address(hook).balance, 4 ether, "native not escrowed");
        assertEq(hook.escrowedZeroForOne(nativeKey.toId(), 0), 4 ether, "native total");
    }

    /// @notice Sending the wrong amount of native currency must revert rather than
    /// escrowing a figure that disagrees with the recorded order.
    function test_RevertsWhenNativeValueMismatchesAmountIn() public {
        PoolKey memory nativeKey = _nativeKey();
        vm.deal(alice, 10 ether);

        vm.expectRevert(WalrasHook.IncorrectNativeValue.selector);
        vm.prank(alice);
        hook.submitOrder{value: 3 ether}(
            nativeKey, true, 4 ether, MIN_PRICE_LIMIT, uint64(block.timestamp) + DEADLINE
        );
    }

    /// @notice Native value attached to an ERC20 order would be stranded in the contract
    /// with no order to attribute it to, so it is rejected outright.
    function test_RevertsWhenNativeValueAttachedToERC20Order() public {
        vm.deal(alice, 10 ether);

        vm.expectRevert(WalrasHook.UnexpectedNativeValue.selector);
        vm.prank(alice);
        hook.submitOrder{value: 1 ether}(key, true, 1 ether, MIN_PRICE_LIMIT, uint64(block.timestamp) + DEADLINE);
    }

    // --- Validation --------------------------------------------------------------------

    /// @notice Escrowing against a pool this hook does not govern would trap the tokens:
    /// Walras has no settlement authority there, so nothing could ever fill the order.
    function test_RevertsOnUngovernedPool() public {
        PoolKey memory foreign = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });

        vm.expectRevert(WalrasHook.PoolNotGoverned.selector);
        vm.prank(alice);
        hook.submitOrder(foreign, true, 1 ether, MIN_PRICE_LIMIT, uint64(block.timestamp) + DEADLINE);
    }

    function test_RevertsOnZeroAmount() public {
        vm.expectRevert(WalrasHook.ZeroAmount.selector);
        vm.prank(alice);
        hook.submitOrder(key, true, 0, MIN_PRICE_LIMIT, uint64(block.timestamp) + DEADLINE);
    }

    function test_RevertsOnDeadlineAtCurrentTimestamp() public {
        vm.expectRevert(WalrasHook.OrderExpired.selector);
        vm.prank(alice);
        hook.submitOrder(key, true, 1 ether, MIN_PRICE_LIMIT, uint64(block.timestamp));
    }

    function test_RevertsOnLimitPriceAtOrBelowMin() public {
        vm.expectRevert(WalrasHook.InvalidLimitPrice.selector);
        vm.prank(alice);
        hook.submitOrder(
            key, true, 1 ether, TickMath.MIN_SQRT_PRICE, uint64(block.timestamp) + DEADLINE
        );
    }

    function test_RevertsOnLimitPriceAtOrAboveMax() public {
        vm.expectRevert(WalrasHook.InvalidLimitPrice.selector);
        vm.prank(alice);
        hook.submitOrder(
            key, false, 1 ether, TickMath.MAX_SQRT_PRICE, uint64(block.timestamp) + DEADLINE
        );
    }

    // --- Invariant ---------------------------------------------------------------------

    /// @notice Across arbitrary submissions, reported escrow totals must equal the tokens
    /// actually held. This is the property netting and settlement will rely on.
    function testFuzz_EscrowTotalsMatchHeldBalance(uint128[8] calldata amounts, bool[8] calldata directions) public {
        uint256 expectedZeroForOne;
        uint256 expectedOneForZero;

        for (uint256 i = 0; i < 8; i++) {
            uint128 amount = uint128(bound(amounts[i], 1, 100 ether));
            _submit(i % 2 == 0 ? alice : bob, directions[i], amount);

            if (directions[i]) expectedZeroForOne += amount;
            else expectedOneForZero += amount;
        }

        assertEq(hook.escrowedZeroForOne(poolId, 0), expectedZeroForOne, "zeroForOne total");
        assertEq(hook.escrowedOneForZero(poolId, 0), expectedOneForZero, "oneForZero total");
        assertEq(
            MockERC20(Currency.unwrap(currency0)).balanceOf(address(hook)), expectedZeroForOne, "currency0 held"
        );
        assertEq(
            MockERC20(Currency.unwrap(currency1)).balanceOf(address(hook)), expectedOneForZero, "currency1 held"
        );
        assertEq(hook.orderCount(poolId, 0), 8, "count");
    }
}

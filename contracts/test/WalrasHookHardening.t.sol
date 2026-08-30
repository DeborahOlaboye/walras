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

/// @notice A token that delivers less than it was asked to transfer, as fee-on-transfer
/// and rebasing tokens do.
contract ShortfallToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount * 99 / 100;
        return true;
    }
}

/// @notice A token that calls back into the hook while it is mid-transfer.
contract ReenteringToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    WalrasHook public hook;
    PoolKey public key;
    bool public armed;

    /// @dev The reentrant call is made inside a try/catch so its revert does not simply
    /// bubble out as a failed transfer. Capturing the reason is what lets the test prove
    /// the guard rejected the re-entry, rather than that something merely went wrong.
    bytes public reentryError;
    bool public reentrySucceeded;

    function arm(WalrasHook _hook, PoolKey memory _key) external {
        hook = _hook;
        key = _key;
        armed = true;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (armed) {
            armed = false;
            try hook.poke(key) {
                reentrySucceeded = true;
            } catch (bytes memory err) {
                reentryError = err;
            }
        }
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice Section 8: hardening. Exclusivity is what makes these cases matter — nothing
/// else can trade against a Walras pool, so a batch that cannot settle would strand its
/// escrow and take the pool with it.
contract WalrasHookHardeningTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    WalrasHook internal hook;
    PoolId internal poolId;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint64 internal constant BATCH_DURATION = 60;
    uint16 internal constant BOUNTY_BIPS = 500;
    uint16 internal constant MAX_ORDERS = 8;
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
    }

    function _fundAndApprove(address who) internal {
        MockERC20(Currency.unwrap(currency0)).mint(who, 10_000 ether);
        MockERC20(Currency.unwrap(currency1)).mint(who, 10_000 ether);
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(hook), type(uint256).max);
        vm.stopPrank();
    }

    function _submitTo(PoolKey memory target, address who, bool zeroForOne, uint128 amountIn)
        internal
        returns (uint256 index)
    {
        vm.prank(who);
        (, index) = hook.submitOrder(
            target,
            zeroForOne,
            amountIn,
            zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT,
            uint64(block.timestamp) + DEADLINE
        );
    }

    // --- Circuit breaker ---------------------------------------------------------------

    /// @dev Same hook, but a pool that was never initialized. Settlement reads a price of
    /// zero from it and cannot solve, which is a realistic stand-in for any settlement that
    /// reverts for reasons the contract cannot anticipate.
    function _uninitializedKey() internal view returns (PoolKey memory) {
        return PoolKey(currency0, currency1, 500, 10, IHooks(address(hook)));
    }

    /// @notice A batch whose settlement reverts must not take the pool with it. Exclusivity
    /// means nothing else can trade, so the escrow would be stranded for good.
    function test_FailedSettlementIsRecordedRatherThanReverting() public {
        PoolKey memory broken = _uninitializedKey();
        _submitTo(broken, alice, true, 1 ether);
        _submitTo(broken, bob, false, 1 ether);

        vm.warp(block.timestamp + BATCH_DURATION + 1);
        hook.poke(broken);

        (,,, bool settled, bool failed) = hook.batches(broken.toId(), 0);
        assertTrue(settled, "batch left open after a failed settlement");
        assertTrue(failed, "failure not recorded");
    }

    /// @notice Everyone in a failed batch gets their input back. Their orders never traded,
    /// so there is nothing else they could be owed.
    function test_FailedBatchRefundsEveryOrder() public {
        PoolKey memory broken = _uninitializedKey();
        uint256 aliceIndex = _submitTo(broken, alice, true, 1 ether);
        uint256 bobIndex = _submitTo(broken, bob, false, 2 ether);

        vm.warp(block.timestamp + BATCH_DURATION + 1);
        hook.poke(broken);

        uint256 aliceBefore = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        uint256 bobBefore = MockERC20(Currency.unwrap(currency1)).balanceOf(bob);

        hook.claim(broken, 0, aliceIndex);
        hook.claim(broken, 0, bobIndex);

        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(alice), aliceBefore + 1 ether, "alice not refunded");
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(bob), bobBefore + 2 ether, "bob not refunded");
    }

    /// @notice A failed batch must not poison the ones after it.
    function test_PoolKeepsWorkingAfterAFailedBatch() public {
        PoolKey memory broken = _uninitializedKey();
        _submitTo(broken, alice, true, 1 ether);
        vm.warp(block.timestamp + BATCH_DURATION + 1);
        hook.poke(broken);

        assertEq(hook.currentBatchId(broken.toId()), 1, "batch did not advance past the failure");

        _submitTo(broken, alice, true, 1 ether);
        assertEq(hook.orderCount(broken.toId(), 1), 1, "cannot submit after a failed batch");
    }

    /// @notice Settlement is external only so its failure can be caught. Nothing outside
    /// this contract may call it.
    function test_SettlementCannotBeCalledDirectly() public {
        vm.expectRevert(WalrasHook.NotSelf.selector);
        hook.settleBatch(poolId, 0, key);
    }

    // --- Token behaviour ---------------------------------------------------------------

    /// @notice A token that delivers less than it was asked to move would leave the escrow
    /// totals claiming more than the contract holds, making some later claim unpayable. It
    /// is refused at submission rather than discovered at settlement.
    function test_RejectsTokensThatDeliverLessThanAsked() public {
        ShortfallToken shortfall = new ShortfallToken();
        shortfall.mint(alice, 100 ether);

        PoolKey memory shortfallKey = _keyWith(address(shortfall));

        vm.startPrank(alice);
        shortfall.approve(address(hook), type(uint256).max);
        vm.expectRevert(WalrasHook.InexactTransfer.selector);
        hook.submitOrder(
            shortfallKey, _isCurrency0(address(shortfall)), 1 ether, MIN_PRICE_LIMIT, uint64(block.timestamp) + DEADLINE
        );
        vm.stopPrank();
    }

    /// @notice A token that calls back into the hook mid-transfer must not be able to
    /// re-enter. Escrow is recorded before custody is taken, so a re-entrant call would
    /// otherwise observe the contract mid-update.
    function test_RejectsReentryFromATokenCallback() public {
        ReenteringToken reentrant = new ReenteringToken();
        reentrant.mint(alice, 100 ether);

        PoolKey memory reentrantKey = _keyWith(address(reentrant));
        reentrant.arm(hook, reentrantKey);

        vm.startPrank(alice);
        reentrant.approve(address(hook), type(uint256).max);
        hook.submitOrder(
            reentrantKey, _isCurrency0(address(reentrant)), 1 ether, MIN_PRICE_LIMIT, uint64(block.timestamp) + DEADLINE
        );
        vm.stopPrank();

        assertFalse(reentrant.reentrySucceeded(), "re-entry was allowed");
        assertEq(
            reentrant.reentryError(),
            abi.encodeWithSelector(WalrasHook.Reentrancy.selector),
            "re-entry failed for the wrong reason"
        );
    }

    /// @dev Pairs an arbitrary token against currency1, respecting v4's ordering rule.
    function _keyWith(address token) internal view returns (PoolKey memory) {
        address other = Currency.unwrap(currency1);
        (address lower, address upper) = token < other ? (token, other) : (other, token);
        return PoolKey(Currency.wrap(lower), Currency.wrap(upper), 3000, 60, IHooks(address(hook)));
    }

    function _isCurrency0(address token) internal view returns (bool) {
        return token < Currency.unwrap(currency1);
    }

    // --- Batch size --------------------------------------------------------------------

    /// @notice Settlement walks a batch several times over, so an unbounded batch is a way
    /// to push it past the block gas limit and strand everyone inside it. Orders past the
    /// cap are refused, and land in the next batch once this one closes.
    function test_BatchesAreCappedInSize() public {
        for (uint256 i = 0; i < MAX_ORDERS; i++) {
            _submitTo(key, alice, true, 0.01 ether);
        }
        assertEq(hook.orderCount(poolId, 0), MAX_ORDERS, "cap not reached");

        vm.expectRevert(WalrasHook.BatchFull.selector);
        _submitTo(key, alice, true, 0.01 ether);
    }

    function test_CapAppliesPerBatchNotForever() public {
        for (uint256 i = 0; i < MAX_ORDERS; i++) {
            _submitTo(key, alice, true, 0.01 ether);
        }

        vm.warp(block.timestamp + BATCH_DURATION + 1);
        _submitTo(key, alice, true, 0.01 ether);

        assertEq(hook.currentBatchId(poolId), 1, "did not roll into a fresh batch");
        assertEq(hook.orderCount(poolId, 1), 1, "new batch did not accept the order");
    }

    function test_RejectsZeroMaxOrdersAtConstruction() public {
        vm.expectRevert(WalrasHook.BatchFull.selector);
        new WalrasHook(IPoolManager(address(manager)), BATCH_DURATION, BOUNTY_BIPS, 0);
    }

    function test_RejectsAnExcessiveBounty() public {
        vm.expectRevert(WalrasHook.BountyTooLarge.selector);
        new WalrasHook(IPoolManager(address(manager)), BATCH_DURATION, 5_000, MAX_ORDERS);
    }
}

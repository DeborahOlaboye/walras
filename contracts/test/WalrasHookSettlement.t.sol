// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {WalrasHook} from "../src/WalrasHook.sol";

/// @notice Section 6: settlement. This is where the mechanism either does what the README
/// claims or does not — netted flow clearing without consuming liquidity, an imbalance
/// executing once against the curve, and LPs paid in both cases.
contract WalrasHookSettlementTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    WalrasHook internal hook;
    PoolId internal poolId;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint64 internal constant BATCH_DURATION = 60;
    uint16 internal constant BOUNTY_BIPS = 500;
    uint16 internal constant MAX_ORDERS = 64;
    uint64 internal constant DEADLINE = 1 days;
    uint24 internal constant POOL_FEE = 3000;

    /// @dev Liquidity spanning the whole range, so its depth is the same at every price.
    /// The clearing price solves against a single liquidity value, which is exact under
    /// that condition and approximate otherwise.
    int24 internal constant FULL_RANGE_LOWER = -887220;
    int24 internal constant FULL_RANGE_UPPER = 887220;

    event BatchSettled(
        PoolId indexed poolId,
        uint256 indexed batchId,
        uint160 clearingSqrtPriceX96,
        bool residualZeroForOne,
        uint256 residualAmount,
        uint256 donatedToLps0,
        uint256 donatedToLps1
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

        key = PoolKey(currency0, currency1, POOL_FEE, 60, IHooks(address(hook)));
        manager.initialize(key, SQRT_PRICE_1_1);
        poolId = key.toId();

        modifyLiquidityRouter.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: FULL_RANGE_LOWER,
                tickUpper: FULL_RANGE_UPPER,
                liquidityDelta: 1e21,
                salt: 0
            }),
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

    function _submit(address who, bool zeroForOne, uint128 amountIn) internal {
        vm.prank(who);
        hook.submitOrder(
            key, zeroForOne, amountIn, zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT, uint64(block.timestamp) + DEADLINE
        );
    }

    function _settle() internal {
        vm.warp(block.timestamp + BATCH_DURATION + 1);
        vm.prank(carol);
        hook.poke(key);
    }

    function _poolPrice() internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = manager.getSlot0(poolId);
    }

    function _settlement(uint256 batchId)
        internal
        view
        returns (uint160 clearing, uint256 gross0, uint256 payout0, uint256 gross1, uint256 payout1)
    {
        (clearing, gross0, payout0, gross1, payout1) = hook.settlements(poolId, batchId);
    }

    // --- The headline claim ------------------------------------------------------------

    /// @notice Offsetting flow clears against itself and never reaches the curve. The pool
    /// price is identical afterwards, which is the whole point: gross volume traded, zero
    /// liquidity consumed, and so nothing for an arbitrageur to have front-run.
    function test_OffsettingFlowNeverTouchesTheCurve() public {
        uint160 priceBefore = _poolPrice();

        _submit(alice, true, 1 ether);
        _submit(bob, false, 1 ether);
        _settle();

        assertEq(_poolPrice(), priceBefore, "pool price moved on a balanced batch");

        (uint160 clearing,,,,) = _settlement(0);
        assertEq(clearing, priceBefore, "did not clear at the pool price");
    }

    /// @notice The sustainability claim, made concrete: volume that never consumed
    /// liquidity still pays the people who supplied it. Both sides netted here, so the
    /// pool earned no swap fee at all — every token the LPs receive comes from Walras
    /// charging netted volume the pool's own rate and donating it.
    function test_NettedVolumeStillPaysLps() public {
        vm.recordLogs();

        _submit(alice, true, 1 ether);
        _submit(bob, false, 1 ether);
        _settle();

        (uint256 donated0, uint256 donated1) = _donatedFromLogs();
        assertGt(donated0, 0, "LPs received no currency0 on netted volume");
        assertGt(donated1, 0, "LPs received no currency1 on netted volume");
    }

    /// @notice Whoever absorbs the cost of settling on everyone else's behalf is paid for
    /// it, out of the value the settlement itself produced.
    function test_SettlerIsPaidABounty() public {
        uint256 before0 = MockERC20(Currency.unwrap(currency0)).balanceOf(carol);
        uint256 before1 = MockERC20(Currency.unwrap(currency1)).balanceOf(carol);

        _submit(alice, true, 1 ether);
        _submit(bob, false, 1 ether);
        _settle();

        assertGt(MockERC20(Currency.unwrap(currency0)).balanceOf(carol), before0, "no currency0 bounty");
        assertGt(MockERC20(Currency.unwrap(currency1)).balanceOf(carol), before1, "no currency1 bounty");
    }

    // --- Imbalanced batches ------------------------------------------------------------

    /// @notice A one-directional batch is the case with nothing to offset. All of it
    /// becomes the residual, and it executes once against the curve.
    function test_OneDirectionalBatchExecutesAgainstTheCurve() public {
        uint160 priceBefore = _poolPrice();

        _submit(alice, true, 10 ether);
        _settle();

        assertLt(_poolPrice(), priceBefore, "selling currency0 did not push the price down");
    }

    function test_ImbalanceInTheOtherDirectionRaisesThePrice() public {
        uint160 priceBefore = _poolPrice();

        _submit(alice, false, 10 ether);
        _settle();

        assertGt(_poolPrice(), priceBefore, "selling currency1 did not push the price up");
    }

    /// @notice Only the unmatched part reaches the pool. Ten against nine leaves one, and
    /// the price moves far less than the ten would have moved it alone.
    function test_OnlyTheImbalanceReachesThePool() public {
        uint160 priceBefore = _poolPrice();

        _submit(alice, true, 10 ether);
        _submit(bob, false, 9 ether);
        _settle();

        uint160 nettedPrice = _poolPrice();
        assertLt(nettedPrice, priceBefore, "residual did not execute");

        // Same gross flow, nothing to net against.
        _submit(alice, true, 10 ether);
        _settle();

        uint160 grossPrice = _poolPrice();
        assertLt(grossPrice, nettedPrice, "netting did not shield the curve");
        assertLt(priceBefore - nettedPrice, nettedPrice - grossPrice, "netting barely helped");
    }

    /// @notice When the imbalance is large enough for the marginal price to diverge from
    /// the average along the curve, that gap is the arbitrageur's usual price improvement —
    /// and it goes to the LPs instead.
    function test_LargeResidualDonatesSurplusToLps() public {
        vm.recordLogs();

        _submit(alice, true, 500 ether);
        _settle();

        (, uint256 donated1) = _donatedFromLogs();
        assertGt(donated1, 0, "surplus was not donated to LPs");
    }

    // --- Solvency ----------------------------------------------------------------------

    /// @notice Settlement must never reserve more than the batch actually holds. Where the
    /// pool's swap fee outweighs the marginal-versus-average gap there is no surplus, and
    /// the reserved payout is capped at what is available rather than promised and missing.
    function test_ReservedPayoutsNeverExceedWhatIsHeld() public {
        _submit(alice, true, 4 ether);
        _submit(bob, false, 1 ether);
        _settle();

        (,, uint256 payout0,, uint256 payout1) = _settlement(0);

        assertLe(payout0, MockERC20(Currency.unwrap(currency0)).balanceOf(address(hook)), "currency0 oversubscribed");
        assertLe(payout1, MockERC20(Currency.unwrap(currency1)).balanceOf(address(hook)), "currency1 oversubscribed");
    }

    function test_PayoutsNeverExceedGrossEntitlements() public {
        _submit(alice, true, 3 ether);
        _submit(bob, false, 2 ether);
        _settle();

        (, uint256 gross0, uint256 payout0, uint256 gross1, uint256 payout1) = _settlement(0);
        assertLe(payout0, gross0, "reserved more currency0 than owed");
        assertLe(payout1, gross1, "reserved more currency1 than owed");
    }

    /// @notice Across arbitrary two-sided batches the contract must always hold at least
    /// what it has promised. This is the invariant claims are built on.
    function testFuzz_SettlementStaysSolvent(uint128 rawA, uint128 rawB) public {
        uint128 amount0 = uint128(bound(rawA, 0.001 ether, 200 ether));
        uint128 amount1 = uint128(bound(rawB, 0.001 ether, 200 ether));

        _submit(alice, true, amount0);
        _submit(bob, false, amount1);
        _settle();

        (,, uint256 payout0,, uint256 payout1) = _settlement(0);
        assertLe(payout0, MockERC20(Currency.unwrap(currency0)).balanceOf(address(hook)), "currency0 short");
        assertLe(payout1, MockERC20(Currency.unwrap(currency1)).balanceOf(address(hook)), "currency1 short");
    }

    function _donatedFromLogs() internal view returns (uint256 donated0, uint256 donated1) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != BatchSettled.selector) continue;
            (,,, uint256 d0, uint256 d1) = abi.decode(logs[i].data, (uint160, bool, uint256, uint256, uint256));
            donated0 = d0;
            donated1 = d1;
        }
    }
}

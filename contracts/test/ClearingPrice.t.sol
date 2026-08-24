// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {ClearingPrice} from "../src/libraries/ClearingPrice.sol";
import {Order} from "../src/types/Order.sol";

/// @notice Section 5: solving for `P*`. The closed form is checked two ways — against
/// cases whose answer is known by construction, and differentially against a bisection
/// that finds the same root by a completely different route. Bisection is valid here only
/// because excess demand is monotone in price, which is also what makes the root unique.
contract ClearingPriceTest is Test {
    uint160 internal constant SQRT_P_1 = uint160(FixedPoint96.Q96);
    uint160 internal constant SQRT_P_4 = uint160(2 * FixedPoint96.Q96);
    uint64 internal constant NEVER = type(uint64).max;

    Order[] internal orders;

    function _push(bool zeroForOne, uint128 amountIn, uint160 limit) internal {
        orders.push(
            Order({
                owner: address(this),
                deadline: NEVER,
                zeroForOne: zeroForOne,
                sqrtPriceLimitX96: limit,
                amountIn: amountIn
            })
        );
    }

    /// @dev Independent oracle. Re-derives excess demand from the definitions rather than
    /// calling the library's own helper, so agreement is evidence about the algebra and
    /// the fixed-point scaling rather than a restatement of them.
    function _excessDemand(uint256 x0, uint256 x1, uint128 liquidity, uint160 sqrtStart, uint160 sqrtAt)
        internal
        pure
        returns (int256)
    {
        uint256 q96 = FixedPoint96.Q96;
        uint256 x1InCurrency0 = FullMath.mulDiv(FullMath.mulDiv(x1, q96, sqrtAt), q96, sqrtAt);
        int256 batchSide = int256(x0) - int256(x1InCurrency0);
        int256 curveSide =
            int256(FullMath.mulDiv(liquidity, q96, sqrtAt)) - int256(FullMath.mulDiv(liquidity, q96, sqrtStart));
        return batchSide - curveSide;
    }

    function _bisectOracle(uint256 x0, uint256 x1, uint128 liquidity, uint160 sqrtStart)
        internal
        pure
        returns (uint160)
    {
        uint160 low = TickMath.MIN_SQRT_PRICE + 1;
        uint160 high = TickMath.MAX_SQRT_PRICE - 1;
        while (high - low > 1) {
            uint160 mid = low + (high - low) / 2;
            if (_excessDemand(x0, x1, liquidity, sqrtStart, mid) < 0) low = mid;
            else high = mid;
        }
        return low;
    }

    // --- Cases with a known answer -----------------------------------------------------

    /// @notice The self-check the formulation is built around: a batch that already
    /// balances at the pool's price must return that price untouched, with no residual and
    /// nothing for the pool to do.
    function test_BalancedBatchClearsAtThePoolPrice() public pure {
        assertEq(ClearingPrice.solveSegment(5 ether, 5 ether, 1 ether, SQRT_P_1), SQRT_P_1);
    }

    function test_EmptyBatchClearsAtThePoolPrice() public pure {
        assertEq(ClearingPrice.solveSegment(0, 0, 1 ether, SQRT_P_1), SQRT_P_1);
    }

    /// @notice With no pool liquidity the batch can only clear against itself, so the price
    /// is whatever makes the two sides equal — a pure netting price.
    function test_WithoutLiquidityThePriceIsPureNetting() public pure {
        assertEq(ClearingPrice.solveSegment(1 ether, 4 ether, 0, SQRT_P_1), SQRT_P_4);
    }

    /// @notice Sellers of currency0 push the price down; sellers of currency1 push it up.
    /// One equation produces both without branching on which side is heavy.
    function test_ImbalanceMovesThePriceTheRightWay() public pure {
        assertLt(ClearingPrice.solveSegment(5 ether, 0, 1 ether, SQRT_P_1), SQRT_P_1, "currency0 heavy");
        assertGt(ClearingPrice.solveSegment(0, 5 ether, 1 ether, SQRT_P_1), SQRT_P_1, "currency1 heavy");
    }

    /// @notice Deeper liquidity absorbs the same imbalance with less price movement.
    function test_DeeperLiquidityDampensTheMove() public pure {
        uint160 shallow = ClearingPrice.solveSegment(5 ether, 0, 1 ether, SQRT_P_1);
        uint160 deep = ClearingPrice.solveSegment(5 ether, 0, 1000 ether, SQRT_P_1);
        assertLt(shallow, deep, "deeper liquidity moved further");
        assertLt(deep, SQRT_P_1, "deep pool did not move at all");
    }

    /// @notice No liquidity and no currency0 anywhere leaves demand unbounded. Reverting is
    /// the honest answer; returning a clamped price would settle orders at a fiction.
    /// @dev `solveSegment` is an internal library function and gets inlined, so it has to
    /// be reached through an external call for `expectRevert` to observe the revert.
    function solveSegmentExternal(uint256 x0, uint256 x1, uint128 liquidity, uint160 sqrtStart)
        external
        pure
        returns (uint160)
    {
        return ClearingPrice.solveSegment(x0, x1, liquidity, sqrtStart);
    }

    function test_RevertsWhenNothingCanSupplyCurrency0() public {
        vm.expectRevert(ClearingPrice.NoSupply.selector);
        this.solveSegmentExternal(0, 5 ether, 0, SQRT_P_1);
    }

    // --- Differential against bisection ------------------------------------------------

    /// @notice The main check on the algebra and the Q96 scaling. Bisection converges on
    /// the true crossing from first principles; the closed form must land in the same
    /// place. Compared relatively, since integer square-root truncation scales with the
    /// magnitude of the inputs.
    function testFuzz_ClosedFormAgreesWithBisection(uint128 rawX0, uint128 rawX1, uint128 rawL, uint160 rawStart)
        public
        pure
    {
        uint256 x0 = bound(rawX0, 0, 1e27);
        uint256 x1 = bound(rawX1, 0, 1e27);
        uint128 liquidity = uint128(bound(rawL, 1e15, 1e27));
        uint160 sqrtStart = uint160(bound(rawStart, FixedPoint96.Q96 / 65536, FixedPoint96.Q96 * 65536));

        uint160 closedForm = ClearingPrice.solveSegment(x0, x1, liquidity, sqrtStart);
        uint160 bisected = _bisectOracle(x0, x1, liquidity, sqrtStart);

        assertApproxEqRel(uint256(closedForm), uint256(bisected), 1e9, "closed form disagrees with bisection");
    }

    /// @notice Monotonicity is the premise the uniqueness argument rests on. If excess
    /// demand were not monotone the root would not be unique and bisection would be
    /// unsound as a fallback.
    function testFuzz_ExcessDemandIsMonotoneInPrice(
        uint128 rawX0,
        uint128 rawX1,
        uint128 rawL,
        uint160 rawA,
        uint160 rawB
    ) public pure {
        uint256 x0 = bound(rawX0, 0, 1e27);
        uint256 x1 = bound(rawX1, 0, 1e27);
        uint128 liquidity = uint128(bound(rawL, 1e15, 1e27));
        uint160 lower = uint160(bound(rawA, FixedPoint96.Q96 / 65536, FixedPoint96.Q96 * 65536));
        uint160 upper = uint160(bound(rawB, lower, FixedPoint96.Q96 * 65536));

        int256 atLower = ClearingPrice.excessDemand(x0, x1, liquidity, SQRT_P_1, lower);
        int256 atUpper = ClearingPrice.excessDemand(x0, x1, liquidity, SQRT_P_1, upper);
        assertLe(atLower, atUpper, "excess demand fell as price rose");
    }

    /// @notice The root the closed form returns must be a root: excess demand there should
    /// be negligible next to the size of the batch, not merely finite.
    function testFuzz_ClosedFormLandsOnTheRoot(uint128 rawX0, uint128 rawX1, uint128 rawL) public pure {
        uint256 x0 = bound(rawX0, 1e12, 1e24);
        uint256 x1 = bound(rawX1, 1e12, 1e24);
        uint128 liquidity = uint128(bound(rawL, 1e18, 1e24));

        uint160 root = ClearingPrice.solveSegment(x0, x1, liquidity, SQRT_P_1);
        int256 residualDemand = _excessDemand(x0, x1, liquidity, SQRT_P_1, root);
        uint256 magnitude = residualDemand < 0 ? uint256(-residualDemand) : uint256(residualDemand);

        assertLt(magnitude, (x0 + x1) / 1e9 + 1e6, "excess demand at the root is not negligible");
    }

    // --- Whole-batch solve, with limit prices ------------------------------------------

    function test_SolveMatchesSegmentWhenNoLimitBinds() public {
        _push(true, 5 ether, TickMath.MIN_SQRT_PRICE + 1);
        _push(false, 5 ether, TickMath.MAX_SQRT_PRICE - 1);

        (uint160 solved,) = ClearingPrice.solve(orders, 1 ether, SQRT_P_1, uint64(block.timestamp));
        assertEq(solved, ClearingPrice.solveSegment(5 ether, 5 ether, 1 ether, SQRT_P_1));
    }

    /// @notice A limit price can make eligible volume jump, and the clearing price then
    /// sits exactly at the jump rather than either side of it.
    ///
    /// A large seller of currency0 with a floor at parity cannot be part of any price it
    /// would itself create: admitting all 50 drags the price far below its own floor, and
    /// excluding it lets the lone currency1 seller push the price above parity. Excess
    /// demand is negative just below parity and sharply positive at it, so the root is the
    /// discontinuity itself. Both the fast path and the bisection fallback land there.
    ///
    /// The economically correct fill at such a price rations the marginal order — admitting
    /// exactly the 1 ether that balances the batch, rather than all 50 or none. Section 5
    /// only has to find the price; deciding fills at it belongs to settlement, and is
    /// recorded as an open item there.
    function test_ClearingPriceSitsAtALimitPriceDiscontinuity() public {
        _push(true, 50 ether, SQRT_P_1);
        _push(false, 1 ether, TickMath.MAX_SQRT_PRICE - 1);

        (uint160 solved,) = ClearingPrice.solve(orders, 1 ether, SQRT_P_1, uint64(block.timestamp));
        uint160 ifItHadFilled = ClearingPrice.solveSegment(50 ether, 1 ether, 1 ether, SQRT_P_1);

        assertGt(solved, ifItHadFilled, "priced-out order still dragged the price down with it");
        assertApproxEqRel(uint256(solved), uint256(SQRT_P_1), 1e9, "did not settle at the discontinuity");
    }

    /// @notice Whatever price `solve` returns, the orders eligible at that price must be
    /// exactly the ones it was computed from. That self-consistency is the definition of a
    /// clearing price here.
    function test_SolvedPriceIsSelfConsistent() public {
        _push(true, 3 ether, SQRT_P_1);
        _push(true, 7 ether, TickMath.MIN_SQRT_PRICE + 1);
        _push(false, 4 ether, SQRT_P_4);
        _push(false, 2 ether, TickMath.MAX_SQRT_PRICE - 1);

        (uint160 solved,) = ClearingPrice.solve(orders, 10 ether, SQRT_P_1, uint64(block.timestamp));
        (uint256 x0, uint256 x1) = _eligibleAt(solved);

        assertEq(ClearingPrice.solveSegment(x0, x1, 10 ether, SQRT_P_1), solved, "not a fixed point");
    }

    function _eligibleAt(uint160 sqrtPriceX96) internal view returns (uint256 x0, uint256 x1) {
        for (uint256 i = 0; i < orders.length; i++) {
            Order memory order = orders[i];
            bool eligible = order.zeroForOne
                ? sqrtPriceX96 >= order.sqrtPriceLimitX96
                : sqrtPriceX96 <= order.sqrtPriceLimitX96;
            if (!eligible) continue;
            if (order.zeroForOne) x0 += order.amountIn;
            else x1 += order.amountIn;
        }
    }

    function test_EmptyOrderBookClearsAtThePoolPrice() public view {
        (uint160 solved,) = ClearingPrice.solve(orders, 1 ether, SQRT_P_1, uint64(block.timestamp));
        assertEq(solved, SQRT_P_1);
    }
}

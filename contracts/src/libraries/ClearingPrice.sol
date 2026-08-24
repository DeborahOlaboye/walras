// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";

import {Order} from "../types/Order.sol";
import {Netting} from "./Netting.sol";

/// @title ClearingPrice
/// @notice Solves for `P*` — the price at which batch supply, batch demand, and pool
/// liquidity intersect. Every order in a batch settles at this one price.
///
/// @dev The batch's excess demand for currency0 at price `P` is
///
///     Z(P) = X0 - X1/P
///
/// and the amount of currency0 the curve absorbs moving the pool from `s_a` to `s`
/// (working in sqrt-price, constant liquidity `L`) is
///
///     A(s) = L * (1/s - 1/s_a)
///
/// Setting `Z = A` and clearing denominators gives a quadratic in sqrt-price:
///
///     (X0 + L/s_a) * s^2 - L * s - X1 = 0
///
/// whose positive root is the clearing price. Three properties make this the right
/// formulation. One equation covers both directions — with `X1 = 0` the root falls below
/// `s_a` (sellers of currency0 push the price down) and with `X0 = 0` it rises above.
/// It self-checks: a batch that already balances at the pool's price returns exactly that
/// price. And it has exactly one solution, because `Z` is non-decreasing in price while
/// `A` is non-increasing, so the two can cross only once.
///
/// No oracle appears anywhere. `P*` is a function of the batch's own orders and the pool's
/// own liquidity, which is what makes an arbitrageur's intent clear at the corrected price
/// rather than the stale one.
library ClearingPrice {
    /// @notice Thrown when the batch demands currency0 that neither the pool nor the batch
    /// can supply — no liquidity and no sellers of currency0 — leaving the price unbounded.
    error NoSupply();

    /// Limit prices make eligible volume jump rather than vary smoothly, so the crossing
    /// can fall on a discontinuity: excess demand is negative just below some limit and
    /// sharply positive at it, and no price strictly satisfies the batch. The root returned
    /// in that case is the discontinuity itself, which is the correct clearing price. What
    /// it implies is that the orders eligible there over-supply the batch, and the
    /// economically correct response is to ration the marginal order — filling exactly the
    /// part of it that balances the batch rather than all of it or none. Finding the price
    /// is this library's job; deciding fills at that price belongs to settlement, and
    /// rationing is an open item there.

    /// @notice Thrown when order sizes and liquidity are large enough that the discriminant
    /// exceeds 256 bits. Solving past this needs 512-bit square roots, which is out of
    /// scope; reverting is preferable to returning a silently wrapped price.
    error AmountsOutOfRange();

    /// @dev Limit prices make eligible volume a step function of price, so the closed form
    /// has to be re-solved as orders enter and leave. In practice the set settles within
    /// two or three passes; this caps the fast path before falling back.
    uint256 internal constant MAX_ELIGIBILITY_PASSES = 8;

    /// @dev Enough halvings to pin a sqrt price across its full representable range. Only
    /// reached when the eligible set refuses to settle, which the fast path makes rare.
    uint256 internal constant BISECTION_PASSES = 128;

    /// @notice Solves the intersection for a fixed eligible volume and constant liquidity.
    /// @param x0 Currency0 offered by eligible sellers of currency0.
    /// @param x1 Currency1 offered by eligible sellers of currency1.
    /// @param liquidity Pool liquidity, assumed constant across the move.
    /// @param sqrtPriceCurrentX96 The pool's price before the residual executes.
    /// @dev Exact whenever liquidity really is constant over the range traversed, which is
    /// the case for a full-range position at every price. Both roots of the quadratic are
    /// real because the discriminant is a sum of non-negative terms, and only the positive
    /// one is meaningful as a price.
    function solveSegment(uint256 x0, uint256 x1, uint128 liquidity, uint160 sqrtPriceCurrentX96)
        internal
        pure
        returns (uint160)
    {
        // a = X0 + L/s_a, carried in the same units as the token amounts.
        uint256 a = x0 + FullMath.mulDiv(liquidity, FixedPoint96.Q96, sqrtPriceCurrentX96);
        if (a == 0) revert NoSupply();

        // Q96 factors out of the discriminant, which keeps it inside 256 bits:
        //   sqrt(b^2 + 4ac) with b = L*Q96 and c = X1*Q96^2  ==  Q96 * sqrt(L^2 + 4*a*X1)
        uint256 discriminant = uint256(liquidity) * uint256(liquidity);
        if (x1 != 0) {
            if (a > type(uint256).max / 4 / x1) revert AmountsOutOfRange();
            uint256 term = 4 * a * x1;
            if (term > type(uint256).max - discriminant) revert AmountsOutOfRange();
            discriminant += term;
        }

        uint256 root = FixedPointMathLib.sqrt(discriminant);
        uint256 sqrtPriceX96 = FullMath.mulDiv(uint256(liquidity) + root, FixedPoint96.Q96, 2 * a);

        // A batch heavy enough to drive the pool past the representable range settles at
        // the edge of it; whatever cannot fill there is excluded by its own limit price.
        if (sqrtPriceX96 <= TickMath.MIN_SQRT_PRICE) return TickMath.MIN_SQRT_PRICE + 1;
        if (sqrtPriceX96 >= TickMath.MAX_SQRT_PRICE) return TickMath.MAX_SQRT_PRICE - 1;
        return uint160(sqrtPriceX96);
    }

    /// @notice Excess demand for currency0 at a candidate price: what the batch wants from
    /// the pool, less what the pool would absorb getting there.
    /// @dev Non-decreasing in `sqrtPriceX96`, which is what guarantees the root is unique
    /// and makes bisection a safe fallback. Negative means the price must rise.
    function excessDemand(
        uint256 x0,
        uint256 x1,
        uint128 liquidity,
        uint160 sqrtPriceCurrentX96,
        uint160 sqrtPriceX96
    ) internal pure returns (int256) {
        int256 batchSide = int256(x0) - int256(Netting.token0For1(x1, sqrtPriceX96));
        int256 curveSide = int256(FullMath.mulDiv(liquidity, FixedPoint96.Q96, sqrtPriceX96))
            - int256(FullMath.mulDiv(liquidity, FixedPoint96.Q96, sqrtPriceCurrentX96));
        return batchSide - curveSide;
    }

    /// @notice Solves for the clearing price of a whole batch, accounting for limit prices.
    /// @return sqrtPriceX96 The uniform price every eligible order settles at.
    /// @return leftStartingTick Whether the solution sits in a different tick from the one
    /// the pool started in. Liquidity is assumed constant across the move; for a position
    /// spanning the whole range that assumption holds everywhere and the result is exact,
    /// but for a concentrated pool this flag marks the result as approximate.
    /// @dev Limit prices make eligible volume a step function, so the closed form is
    /// iterated: solve, re-check which orders qualify at the answer, and repeat. A pass
    /// whose eligible set is unchanged by its own answer is self-consistent, and because
    /// the closed form is exact for a fixed set, that answer is the true intersection. The
    /// bisection fallback exists only so termination never depends on that settling.
    function solve(Order[] storage orders, uint128 liquidity, uint160 sqrtPriceCurrentX96)
        internal
        view
        returns (uint160 sqrtPriceX96, bool leftStartingTick)
    {
        (uint256 x0, uint256 x1) = Netting.eligibleVolume(orders, sqrtPriceCurrentX96);

        for (uint256 i = 0; i < MAX_ELIGIBILITY_PASSES; i++) {
            uint160 candidate = solveSegment(x0, x1, liquidity, sqrtPriceCurrentX96);
            (uint256 nextX0, uint256 nextX1) = Netting.eligibleVolume(orders, candidate);

            if (nextX0 == x0 && nextX1 == x1) {
                return (candidate, _leftStartingTick(candidate, sqrtPriceCurrentX96));
            }
            x0 = nextX0;
            x1 = nextX1;
        }

        sqrtPriceX96 = _bisect(orders, liquidity, sqrtPriceCurrentX96);
        return (sqrtPriceX96, _leftStartingTick(sqrtPriceX96, sqrtPriceCurrentX96));
    }

    /// @dev Guaranteed-termination fallback. Excess demand is monotone in price, so
    /// halving the bracket converges on the crossing regardless of how the eligible set
    /// behaves along the way.
    function _bisect(Order[] storage orders, uint128 liquidity, uint160 sqrtPriceCurrentX96)
        private
        view
        returns (uint160)
    {
        uint160 low = TickMath.MIN_SQRT_PRICE + 1;
        uint160 high = TickMath.MAX_SQRT_PRICE - 1;

        for (uint256 i = 0; i < BISECTION_PASSES; i++) {
            if (high - low <= 1) break;
            uint160 mid = low + (high - low) / 2;
            (uint256 x0, uint256 x1) = Netting.eligibleVolume(orders, mid);
            if (excessDemand(x0, x1, liquidity, sqrtPriceCurrentX96, mid) < 0) low = mid;
            else high = mid;
        }
        return low;
    }

    function _leftStartingTick(uint160 target, uint160 start) private pure returns (bool) {
        return TickMath.getTickAtSqrtPrice(target) != TickMath.getTickAtSqrtPrice(start);
    }
}

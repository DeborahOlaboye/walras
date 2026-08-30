// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";

import {Order} from "../types/Order.sol";

/// @title Netting
/// @notice Pure matching logic for a Walras batch: which orders are eligible at a given
/// price, how much of the batch offsets internally, and what imbalance is left for the
/// pool to absorb.
/// @dev Netting and price discovery are a single fixed point — you cannot offset token0
/// against token1 without a price, and the clearing price depends on how large the
/// residual turns out to be. This library takes the price as given and answers the netting
/// half exactly; section 5 solves for the price that makes the answer self-consistent.
library Netting {
    /// @notice The outcome of netting a batch at one candidate price.
    /// @param zeroForOne Direction of the leftover imbalance the pool must absorb.
    /// @param amount Size of that imbalance, denominated in whichever currency
    /// `zeroForOne` is selling. Zero when the batch offsets exactly.
    /// @param matchedZeroForOne Currency0 that changed hands inside the batch without
    /// touching pool liquidity.
    /// @param matchedOneForZero Currency1 that changed hands inside the batch.
    struct Residual {
        bool zeroForOne;
        uint256 amount;
        uint256 matchedZeroForOne;
        uint256 matchedOneForZero;
    }

    /// @notice Values an amount of currency0 in currency1 at `sqrtPriceX96`.
    /// @dev Applies the sqrt price twice rather than squaring it first, which would
    /// overflow for most of the representable range. Rounds down.
    function token1For0(uint256 amount0, uint160 sqrtPriceX96) internal pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(amount0, sqrtPriceX96, FixedPoint96.Q96), sqrtPriceX96, FixedPoint96.Q96);
    }

    /// @notice Values an amount of currency1 in currency0 at `sqrtPriceX96`. Rounds down.
    function token0For1(uint256 amount1, uint160 sqrtPriceX96) internal pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(amount1, FixedPoint96.Q96, sqrtPriceX96), FixedPoint96.Q96, sqrtPriceX96);
    }

    /// @notice Whether a single order would accept `sqrtPriceX96` as its clearing price.
    /// @param asOf The moment eligibility is judged against, which is always the instant
    /// the batch settled — never the present. Claims are made later, by which time every
    /// deadline has passed; judging against `block.timestamp` there would report the whole
    /// batch expired and refund orders that had in fact filled.
    /// @dev A seller of currency0 receives more currency1 as the price rises, so its limit
    /// is a floor; a seller of currency1 wants the opposite, so its limit is a ceiling.
    /// This is the same orientation v4 gives `sqrtPriceLimitX96` on a swap, so a limit
    /// written for one reads correctly against the other.
    function isEligible(Order memory order, uint160 sqrtPriceX96, uint64 asOf) internal pure returns (bool) {
        if (order.deadline < asOf) return false;
        return order.zeroForOne ? sqrtPriceX96 >= order.sqrtPriceLimitX96 : sqrtPriceX96 <= order.sqrtPriceLimitX96;
    }

    /// @notice Sums the input amounts of every order willing to trade at `sqrtPriceX96`,
    /// split by direction.
    /// @dev Eligible volume is a step function of price: raising the price brings sellers
    /// of currency0 in and pushes sellers of currency1 out. Section 5 walks that function
    /// looking for the price at which the two sides balance against pool liquidity.
    function eligibleVolume(Order[] storage orders, uint160 sqrtPriceX96, uint64 asOf)
        internal
        view
        returns (uint256 eligible0, uint256 eligible1)
    {
        uint256 length = orders.length;
        for (uint256 i = 0; i < length; i++) {
            Order memory order = orders[i];
            if (!isEligible(order, sqrtPriceX96, asOf)) continue;
            if (order.zeroForOne) eligible0 += order.amountIn;
            else eligible1 += order.amountIn;
        }
    }

    /// @notice Offsets the two sides of a batch against each other at `sqrtPriceX96` and
    /// reports what is left over.
    /// @dev Both conversions round down, which understates the matched portion by at most
    /// one unit and moves that dust into the residual. That direction is deliberate: the
    /// matched and residual portions always sum to exactly the escrowed input, so the
    /// contract can never promise out more of either currency than it holds. Dust surfaces
    /// as a marginally worse rate for one side, never as a shortfall.
    function residual(uint256 eligible0, uint256 eligible1, uint160 sqrtPriceX96)
        internal
        pure
        returns (Residual memory)
    {
        uint256 eligible1In0 = token0For1(eligible1, sqrtPriceX96);

        if (eligible0 > eligible1In0) {
            // Sellers of currency0 outweigh the currency1 on offer. Every seller of
            // currency1 fills internally; the excess currency0 goes to the pool.
            return Residual({
                zeroForOne: true,
                amount: eligible0 - eligible1In0,
                matchedZeroForOne: eligible1In0,
                matchedOneForZero: eligible1
            });
        }

        // Otherwise sellers of currency1 are the heavier side, and the currency0 on offer
        // fills internally in full.
        uint256 eligible0In1 = token1For0(eligible0, sqrtPriceX96);
        return Residual({
            zeroForOne: false,
            // Rounding can leave the converted figure a hair above the escrowed total at
            // the balance point; clamping keeps the subtraction from underflowing.
            amount: eligible1 > eligible0In1 ? eligible1 - eligible0In1 : 0,
            matchedZeroForOne: eligible0,
            matchedOneForZero: eligible0In1
        });
    }
}

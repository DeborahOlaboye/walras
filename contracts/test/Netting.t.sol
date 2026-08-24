// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";

import {Netting} from "../src/libraries/Netting.sol";
import {Order} from "../src/types/Order.sol";

/// @notice Section 4: the netting engine. No pool, no oracle, no state machine — this is
/// the pure question of what offsets internally at a given price and what is left for the
/// pool to absorb. The properties pinned here are the ones settlement cannot recover from
/// if they are wrong: conservation of both currencies, and a residual that points the way
/// the imbalance actually leans.
contract NettingTest is Test {
    /// @dev Price 1. `sqrtPriceX96` of Q96 squares back to exactly 1.
    uint160 internal constant SQRT_P_1 = uint160(FixedPoint96.Q96);
    /// @dev Price 4: one currency0 is worth four currency1.
    uint160 internal constant SQRT_P_4 = uint160(2 * FixedPoint96.Q96);
    /// @dev Price 1/4.
    uint160 internal constant SQRT_P_QUARTER = uint160(FixedPoint96.Q96 / 2);

    uint64 internal constant NEVER = type(uint64).max;

    Order[] internal orders;

    function _push(bool zeroForOne, uint128 amountIn, uint160 limit, uint64 deadline) internal {
        orders.push(
            Order({
                owner: address(this),
                deadline: deadline,
                zeroForOne: zeroForOne,
                sqrtPriceLimitX96: limit,
                amountIn: amountIn
            })
        );
    }

    // --- Valuation ---------------------------------------------------------------------

    function test_ConversionsAreIdentityAtPriceOne() public pure {
        assertEq(Netting.token1For0(5 ether, SQRT_P_1), 5 ether, "0 -> 1");
        assertEq(Netting.token0For1(5 ether, SQRT_P_1), 5 ether, "1 -> 0");
    }

    function test_ConversionsRespectPrice() public pure {
        assertEq(Netting.token1For0(3 ether, SQRT_P_4), 12 ether, "0 -> 1 at price 4");
        assertEq(Netting.token0For1(12 ether, SQRT_P_4), 3 ether, "1 -> 0 at price 4");
        assertEq(Netting.token1For0(8 ether, SQRT_P_QUARTER), 2 ether, "0 -> 1 at price 1/4");
    }

    /// @notice Rounding must never manufacture value. A round trip through both
    /// conversions has to come back at or below where it started, at any price.
    function testFuzz_RoundTripNeverInflates(uint128 amount, uint160 sqrtPriceX96) public pure {
        amount = uint128(bound(amount, 0, type(uint96).max));
        sqrtPriceX96 = uint160(bound(sqrtPriceX96, FixedPoint96.Q96 / 65536, FixedPoint96.Q96 * 65536));

        assertLe(Netting.token0For1(Netting.token1For0(amount, sqrtPriceX96), sqrtPriceX96), amount, "0->1->0");
        assertLe(Netting.token1For0(Netting.token0For1(amount, sqrtPriceX96), sqrtPriceX96), amount, "1->0->1");
    }

    // --- Eligibility -------------------------------------------------------------------

    function test_EligibleVolumeSplitsByDirection() public {
        _push(true, 5 ether, SQRT_P_1, NEVER);
        _push(false, 3 ether, SQRT_P_1, NEVER);
        _push(true, 2 ether, SQRT_P_1, NEVER);

        (uint256 eligible0, uint256 eligible1) = Netting.eligibleVolume(orders, SQRT_P_1);
        assertEq(eligible0, 7 ether, "currency0 side");
        assertEq(eligible1, 3 ether, "currency1 side");
    }

    /// @notice An order at exactly its limit price is filled, not skipped. The limit is the
    /// worst price the trader accepts, not a price they refuse.
    function test_OrdersAtTheirExactLimitAreEligible() public {
        _push(true, 1 ether, SQRT_P_1, NEVER);
        _push(false, 1 ether, SQRT_P_1, NEVER);

        (uint256 eligible0, uint256 eligible1) = Netting.eligibleVolume(orders, SQRT_P_1);
        assertEq(eligible0, 1 ether, "currency0 side excluded at its limit");
        assertEq(eligible1, 1 ether, "currency1 side excluded at its limit");
    }

    /// @notice A seller of currency0 wants a high price, so its limit is a floor.
    function test_ZeroForOneExcludedBelowItsLimit() public {
        _push(true, 1 ether, SQRT_P_4, NEVER);

        (uint256 eligible0,) = Netting.eligibleVolume(orders, SQRT_P_1);
        assertEq(eligible0, 0, "filled below its floor");

        (uint256 atLimit,) = Netting.eligibleVolume(orders, SQRT_P_4);
        assertEq(atLimit, 1 ether, "not filled at its floor");
    }

    /// @notice A seller of currency1 wants a low price, so its limit is a ceiling.
    function test_OneForZeroExcludedAboveItsLimit() public {
        _push(false, 1 ether, SQRT_P_1, NEVER);

        (, uint256 eligible1) = Netting.eligibleVolume(orders, SQRT_P_4);
        assertEq(eligible1, 0, "filled above its ceiling");

        (, uint256 atLimit) = Netting.eligibleVolume(orders, SQRT_P_1);
        assertEq(atLimit, 1 ether, "not filled at its ceiling");
    }

    function test_ExpiredOrdersAreIneligibleAtEveryPrice() public {
        vm.warp(1_000_000);
        _push(true, 1 ether, SQRT_P_1, uint64(block.timestamp - 1));
        _push(false, 1 ether, SQRT_P_1, uint64(block.timestamp));

        (uint256 eligible0, uint256 eligible1) = Netting.eligibleVolume(orders, SQRT_P_1);
        assertEq(eligible0, 0, "expired order filled");
        assertEq(eligible1, 1 ether, "order expiring this second wrongly dropped");
    }

    /// @notice Eligible volume is a step function of price: raising it draws sellers of
    /// currency0 in and pushes sellers of currency1 out. Section 5 searches over this.
    function test_RaisingPriceMovesVolumeBetweenSides() public {
        _push(true, 1 ether, SQRT_P_4, NEVER);
        _push(false, 1 ether, SQRT_P_1, NEVER);

        (uint256 low0, uint256 low1) = Netting.eligibleVolume(orders, SQRT_P_1);
        assertEq(low0, 0, "low price: currency0 side in");
        assertEq(low1, 1 ether, "low price: currency1 side out");

        (uint256 high0, uint256 high1) = Netting.eligibleVolume(orders, SQRT_P_4);
        assertEq(high0, 1 ether, "high price: currency0 side out");
        assertEq(high1, 0, "high price: currency1 side in");
    }

    // --- Residual ----------------------------------------------------------------------

    /// @notice A batch that offsets exactly leaves the pool nothing to do. This is the case
    /// the whole mechanism exists to produce: gross volume, zero liquidity consumed.
    function test_NoResidualWhenBatchOffsetsExactly() public pure {
        Netting.Residual memory r = Netting.residual(5 ether, 5 ether, SQRT_P_1);

        assertEq(r.amount, 0, "residual on a balanced batch");
        assertEq(r.matchedZeroForOne, 5 ether, "currency0 matched");
        assertEq(r.matchedOneForZero, 5 ether, "currency1 matched");
    }

    function test_ResidualIsZeroForOneWhenCurrency0Heavier() public pure {
        Netting.Residual memory r = Netting.residual(8 ether, 3 ether, SQRT_P_1);

        assertTrue(r.zeroForOne, "direction");
        assertEq(r.amount, 5 ether, "residual size");
        assertEq(r.matchedZeroForOne, 3 ether, "currency0 matched");
        assertEq(r.matchedOneForZero, 3 ether, "currency1 matched");
    }

    function test_ResidualIsOneForZeroWhenCurrency1Heavier() public pure {
        Netting.Residual memory r = Netting.residual(3 ether, 8 ether, SQRT_P_1);

        assertFalse(r.zeroForOne, "direction");
        assertEq(r.amount, 5 ether, "residual size");
        assertEq(r.matchedZeroForOne, 3 ether, "currency0 matched");
        assertEq(r.matchedOneForZero, 3 ether, "currency1 matched");
    }

    /// @notice Price decides what "heavier" means. Eight currency1 against three currency0
    /// is an imbalance at price 1 and a perfect match at price 4.
    function test_PriceDecidesWhichSideIsHeavier() public pure {
        Netting.Residual memory r = Netting.residual(3 ether, 12 ether, SQRT_P_4);

        assertEq(r.amount, 0, "balanced batch reported as imbalanced");
        assertEq(r.matchedZeroForOne, 3 ether, "currency0 matched");
        assertEq(r.matchedOneForZero, 12 ether, "currency1 matched");
    }

    /// @notice A one-directional batch is the signature of informed flow: nothing offsets,
    /// and the whole of it becomes the residual the pool must price.
    function test_OneDirectionalBatchIsEntirelyResidual() public pure {
        Netting.Residual memory r = Netting.residual(7 ether, 0, SQRT_P_1);

        assertTrue(r.zeroForOne, "direction");
        assertEq(r.amount, 7 ether, "residual size");
        assertEq(r.matchedZeroForOne, 0, "matched anything");
        assertEq(r.matchedOneForZero, 0, "matched anything");
    }

    function test_EmptyBatchHasNoResidual() public pure {
        Netting.Residual memory r = Netting.residual(0, 0, SQRT_P_1);
        assertEq(r.amount, 0, "residual from nothing");
    }

    // --- Invariants --------------------------------------------------------------------

    /// @notice The property settlement cannot recover from: whatever was escrowed is
    /// exactly what gets accounted for. The matched portion plus the residual must equal
    /// the eligible input on the heavy side, and the light side must match in full.
    /// Rounding may shift dust between matched and residual but can never lose or invent a
    /// unit of either currency.
    function testFuzz_MatchedPlusResidualEqualsEligible(uint128 raw0, uint128 raw1, uint160 rawPrice) public pure {
        uint256 eligible0 = bound(raw0, 0, 1e30);
        uint256 eligible1 = bound(raw1, 0, 1e30);
        uint160 sqrtPriceX96 =
            uint160(bound(rawPrice, FixedPoint96.Q96 / 65536, FixedPoint96.Q96 * 65536));

        Netting.Residual memory r = Netting.residual(eligible0, eligible1, sqrtPriceX96);

        if (r.zeroForOne) {
            assertEq(r.matchedZeroForOne + r.amount, eligible0, "currency0 not conserved");
            assertEq(r.matchedOneForZero, eligible1, "currency1 side not filled in full");
        } else {
            assertEq(r.matchedOneForZero + r.amount, eligible1, "currency1 not conserved");
            assertEq(r.matchedZeroForOne, eligible0, "currency0 side not filled in full");
        }
    }

    /// @notice The residual must lean the way the imbalance actually does, valued at the
    /// clearing price. Getting this backwards would push the pool the wrong direction.
    function testFuzz_ResidualDirectionFollowsTheImbalance(uint128 raw0, uint128 raw1, uint160 rawPrice) public pure {
        uint256 eligible0 = bound(raw0, 1, 1e30);
        uint256 eligible1 = bound(raw1, 1, 1e30);
        uint160 sqrtPriceX96 =
            uint160(bound(rawPrice, FixedPoint96.Q96 / 65536, FixedPoint96.Q96 * 65536));

        Netting.Residual memory r = Netting.residual(eligible0, eligible1, sqrtPriceX96);
        uint256 eligible1In0 = Netting.token0For1(eligible1, sqrtPriceX96);

        if (eligible0 > eligible1In0) {
            assertTrue(r.zeroForOne, "currency0 heavy but residual points the other way");
        } else {
            assertFalse(r.zeroForOne, "currency1 heavy but residual points the other way");
        }
    }

    /// @notice The matched portion can never exceed what was actually escrowed on either
    /// side — the guard against netting promising out liquidity that was never deposited.
    function testFuzz_MatchedNeverExceedsEscrow(uint128 raw0, uint128 raw1, uint160 rawPrice) public pure {
        uint256 eligible0 = bound(raw0, 0, 1e30);
        uint256 eligible1 = bound(raw1, 0, 1e30);
        uint160 sqrtPriceX96 =
            uint160(bound(rawPrice, FixedPoint96.Q96 / 65536, FixedPoint96.Q96 * 65536));

        Netting.Residual memory r = Netting.residual(eligible0, eligible1, sqrtPriceX96);

        assertLe(r.matchedZeroForOne, eligible0, "matched more currency0 than escrowed");
        assertLe(r.matchedOneForZero, eligible1, "matched more currency1 than escrowed");
    }
}

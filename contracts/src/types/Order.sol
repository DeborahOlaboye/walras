// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice A single swap intent held in escrow against a batch.
/// @param owner The address that submitted the order and may claim its proceeds.
/// @param deadline Unix timestamp after which the order may no longer be filled.
/// @param zeroForOne Direction: true sells currency0 for currency1.
/// @param sqrtPriceLimitX96 Worst clearing price the owner will accept, in v4's
/// `sqrtPriceLimitX96` convention — a lower bound when `zeroForOne`, an upper bound
/// otherwise.
/// @param amountIn Exact input amount, held in escrow by the hook.
/// @dev Lives outside the hook so the netting library can read it without importing the
/// hook, which would be circular. Occupies three storage slots; tighter packing is
/// possible only by narrowing `amountIn`, which would cap order size, so it is left alone.
struct Order {
    address owner;
    uint64 deadline;
    bool zeroForOne;
    uint160 sqrtPriceLimitX96;
    uint128 amountIn;
}

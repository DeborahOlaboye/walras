// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {CurrencySettler} from "@uniswap/v4-core/test/utils/CurrencySettler.sol";

/// @notice A contract that reaches `PoolManager.swap` on its own, used to prove the
/// exclusivity check in `WalrasHook.beforeSwap` rejects callers it does not recognise.
///
/// @dev It began as a stand-in for settlement while that half of the hook did not yet
/// exist. Now that the hook settles its own batches, this plays the opposite role: it is
/// the impostor. Because it takes the PoolManager lock itself rather than going through
/// a router, it reaches `beforeSwap` the same way a real settlement would — which is
/// what makes its rejection meaningful rather than incidental.
contract MockSettler is IUnlockCallback {
    using CurrencySettler for Currency;
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager public immutable manager;

    constructor(IPoolManager _manager) {
        manager = _manager;
    }

    struct CallbackData {
        PoolKey key;
        IPoolManager.SwapParams params;
    }

    function executeSwap(PoolKey memory key, IPoolManager.SwapParams memory params)
        external
        returns (BalanceDelta delta)
    {
        delta = abi.decode(manager.unlock(abi.encode(CallbackData(key, params))), (BalanceDelta));
    }

    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        require(msg.sender == address(manager));
        CallbackData memory data = abi.decode(rawData, (CallbackData));

        BalanceDelta delta = manager.swap(data.key, data.params, "");

        _settle(data.key.currency0, delta.amount0());
        _settle(data.key.currency1, delta.amount1());

        return abi.encode(delta);
    }

    function _settle(Currency currency, int128 amount) internal {
        if (amount < 0) {
            currency.settle(manager, address(this), uint256(uint128(-amount)), false);
        } else if (amount > 0) {
            currency.take(manager, address(this), uint256(uint128(amount)), false);
        }
    }
}

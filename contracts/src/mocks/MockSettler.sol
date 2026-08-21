// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {CurrencySettler} from "@uniswap/v4-core/test/utils/CurrencySettler.sol";

/// @notice Stands in for Walras's real settlement path (section 6, not yet built) so the
/// exclusivity check in WalrasHook.beforeSwap can be tested against a legitimate caller
/// before the netting/clearing-price/settlement logic exists. Calls `PoolManager.swap`
/// directly and settles the resulting delta out of its own token balance — exactly the
/// role the hook itself will play once settlement is wired into it.
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

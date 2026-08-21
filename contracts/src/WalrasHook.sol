// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";

/// @title WalrasHook
/// @notice A Uniswap v4 hook that enforces pool-native batch settlement with a uniform
/// clearing price. No swap may execute against a Walras-governed pool except through this
/// contract's own settlement path — enforced by `beforeSwap` rejecting any swap whose
/// `sender` is not this contract itself.
/// @dev This is the section-1 skeleton: only the exclusivity enforcement is implemented.
/// Order escrow, batch lifecycle, netting, clearing price, and settlement execution are
/// built in later sections on top of this contract.
contract WalrasHook is IHooks {
    /// @notice Thrown when anything other than the PoolManager calls a hook callback.
    error NotPoolManager();

    /// @notice Thrown when a swap attempts to execute against a Walras-governed pool
    /// without going through this contract's own settlement path.
    error DirectSwapsDisabled();

    /// @notice Thrown when a hook callback this contract does not implement is invoked.
    error NotImplemented();

    IPoolManager public immutable poolManager;

    /// @notice The only address permitted to execute a swap against a Walras-governed
    /// pool. In production this is the hook's own CREATE2-precomputed address (the
    /// settlement logic lives in this same contract, from section 6 onward) — passed in
    /// explicitly rather than hardcoded to `address(this)` so the exclusivity check can be
    /// unit-tested against a mock settler before the real settlement path exists.
    address public immutable authorizedSettler;

    constructor(IPoolManager _poolManager, address _authorizedSettler) {
        poolManager = _poolManager;
        authorizedSettler = _authorizedSettler;
        Hooks.validateHookPermissions(this, getHookPermissions());
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    /// @notice Only `beforeSwap` is active for this hook. Every other callback is left
    /// unimplemented and will never be invoked by the PoolManager as a result.
    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @notice Rejects any swap that did not originate from this contract's own
    /// settlement path. `sender` is the address that called `PoolManager.swap` directly —
    /// in Walras, that will only ever be this contract itself once settlement (section 6)
    /// is wired up. Everything else — routers, aggregators, direct calls — reverts here.
    function beforeSwap(address sender, PoolKey calldata, IPoolManager.SwapParams calldata, bytes calldata)
        external
        view
        override
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (sender != authorizedSettler) revert DirectSwapsDisabled();
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    // --- Unimplemented callbacks -------------------------------------------------------
    // Permission flags above are all false for these, so the PoolManager will never call
    // them. They exist only to satisfy the IHooks interface.

    function beforeInitialize(address, PoolKey calldata, uint160) external pure override returns (bytes4) {
        revert NotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure override returns (bytes4) {
        revert NotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert NotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert NotImplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure override returns (bytes4) {
        revert NotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert NotImplemented();
    }

    function afterSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        override
        returns (bytes4, int128)
    {
        revert NotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert NotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert NotImplemented();
    }
}

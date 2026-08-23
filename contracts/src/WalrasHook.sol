// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

/// @title WalrasHook
/// @notice A Uniswap v4 hook that enforces pool-native batch settlement with a uniform
/// clearing price. No swap may execute against a Walras-governed pool except through this
/// contract's own settlement path — enforced by `beforeSwap` rejecting any swap whose
/// `sender` is not this contract itself.
/// @dev Built in sections. Implemented so far: exclusivity enforcement (section 1) and
/// order escrow / intent submission (section 2). Batch lifecycle, netting, clearing price,
/// settlement execution, and claims are built on top in later sections.
contract WalrasHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using SafeTransferLib for ERC20;

    /// @notice Thrown when anything other than the PoolManager calls a hook callback.
    error NotPoolManager();

    /// @notice Thrown when a swap attempts to execute against a Walras-governed pool
    /// without going through this contract's own settlement path.
    error DirectSwapsDisabled();

    /// @notice Thrown when a hook callback this contract does not implement is invoked.
    error NotImplemented();

    /// @notice Thrown when an order is submitted against a pool this hook does not govern.
    /// Without this check, orders could be escrowed against a pool whose swaps Walras has
    /// no authority over, leaving the input tokens unsettleable.
    error PoolNotGoverned();

    /// @notice Thrown when an order is submitted with a zero input amount.
    error ZeroAmount();

    /// @notice Thrown when an order is submitted with a deadline at or before the current
    /// block timestamp, which could never be filled.
    error OrderExpired();

    /// @notice Thrown when a limit price falls outside the range the pool can ever reach.
    error InvalidLimitPrice();

    /// @notice Thrown when a native-currency order's `msg.value` does not match `amountIn`.
    error IncorrectNativeValue();

    /// @notice Thrown when an ERC20 order is submitted with a non-zero `msg.value`, which
    /// would otherwise be silently stranded in the contract.
    error UnexpectedNativeValue();

    /// @notice A single swap intent held in escrow against a batch.
    /// @param owner The address that submitted the order and may claim its proceeds.
    /// @param deadline Unix timestamp after which the order may no longer be filled.
    /// @param zeroForOne Direction: true sells currency0 for currency1.
    /// @param sqrtPriceLimitX96 Worst clearing price the owner will accept, in v4's
    /// `sqrtPriceLimitX96` convention — a lower bound when `zeroForOne`, an upper bound
    /// otherwise.
    /// @param amountIn Exact input amount, held in escrow by this contract.
    /// @dev Occupies three storage slots. Tighter packing is possible only by narrowing
    /// `amountIn`, which would cap order size, so it is left alone.
    struct Order {
        address owner;
        uint64 deadline;
        bool zeroForOne;
        uint160 sqrtPriceLimitX96;
        uint128 amountIn;
    }

    /// @notice Emitted on every accepted order submission.
    event OrderSubmitted(
        PoolId indexed poolId,
        uint256 indexed batchId,
        address indexed owner,
        uint256 orderIndex,
        bool zeroForOne,
        uint128 amountIn,
        uint160 sqrtPriceLimitX96,
        uint64 deadline
    );

    IPoolManager public immutable poolManager;

    /// @notice The only address permitted to execute a swap against a Walras-governed
    /// pool. In production this is the hook's own CREATE2-precomputed address (the
    /// settlement logic lives in this same contract, from section 6 onward) — passed in
    /// explicitly rather than hardcoded to `address(this)` so the exclusivity check can be
    /// unit-tested against a mock settler before the real settlement path exists.
    address public immutable authorizedSettler;

    /// @notice The batch currently accepting orders, per pool. Advanced by the batch
    /// lifecycle in section 3; until then every order lands in batch 0.
    mapping(PoolId => uint256) public currentBatchId;

    /// @notice Running total of escrowed currency0 awaiting settlement, per pool and
    /// batch. Maintained on submission so that netting (section 4) can compute the batch
    /// residual without a second pass over the order array.
    mapping(PoolId => mapping(uint256 => uint256)) public escrowedZeroForOne;

    /// @notice Running total of escrowed currency1 awaiting settlement, per pool and batch.
    mapping(PoolId => mapping(uint256 => uint256)) public escrowedOneForZero;

    mapping(PoolId => mapping(uint256 => Order[])) internal _orders;

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

    // --- Order submission (section 2) --------------------------------------------------

    /// @notice Submits a swap intent into the pool's currently open batch, taking custody
    /// of the input token. The order does not execute here — it is settled with the rest
    /// of its batch at a single uniform clearing price, and its proceeds are withdrawn
    /// separately via `claim()` (section 7).
    /// @param key The pool to trade against. Must be governed by this hook.
    /// @param zeroForOne Direction: true sells currency0 for currency1.
    /// @param amountIn Exact input amount to escrow.
    /// @param sqrtPriceLimitX96 Worst clearing price the caller will accept. Pass a value
    /// adjacent to `TickMath.MIN_SQRT_PRICE` / `MAX_SQRT_PRICE` for an effectively
    /// unbounded order.
    /// @param deadline Unix timestamp after which the order may no longer be filled.
    /// @return batchId The batch the order was recorded against.
    /// @return orderIndex The order's position within that batch.
    function submitOrder(
        PoolKey calldata key,
        bool zeroForOne,
        uint128 amountIn,
        uint160 sqrtPriceLimitX96,
        uint64 deadline
    ) external payable returns (uint256 batchId, uint256 orderIndex) {
        if (address(key.hooks) != address(this)) revert PoolNotGoverned();
        if (amountIn == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert OrderExpired();
        if (sqrtPriceLimitX96 <= TickMath.MIN_SQRT_PRICE || sqrtPriceLimitX96 >= TickMath.MAX_SQRT_PRICE) {
            revert InvalidLimitPrice();
        }

        PoolId poolId = key.toId();
        batchId = currentBatchId[poolId];
        orderIndex = _orders[poolId][batchId].length;

        _orders[poolId][batchId].push(
            Order({
                owner: msg.sender,
                deadline: deadline,
                zeroForOne: zeroForOne,
                sqrtPriceLimitX96: sqrtPriceLimitX96,
                amountIn: amountIn
            })
        );

        if (zeroForOne) {
            escrowedZeroForOne[poolId][batchId] += amountIn;
        } else {
            escrowedOneForZero[poolId][batchId] += amountIn;
        }

        emit OrderSubmitted(
            poolId, batchId, msg.sender, orderIndex, zeroForOne, amountIn, sqrtPriceLimitX96, deadline
        );

        // Interaction last: every storage write above is already committed, so a token
        // with a transfer callback cannot observe a half-recorded order.
        _pullInput(zeroForOne ? key.currency0 : key.currency1, amountIn);
    }

    /// @notice Number of orders recorded against a given batch.
    function orderCount(PoolId poolId, uint256 batchId) external view returns (uint256) {
        return _orders[poolId][batchId].length;
    }

    /// @notice Reads a single order out of a batch.
    function getOrder(PoolId poolId, uint256 batchId, uint256 index) external view returns (Order memory) {
        return _orders[poolId][batchId][index];
    }

    /// @notice Takes custody of an order's input amount. Native currency arrives as
    /// `msg.value`; everything else is pulled by `transferFrom`, which requires the caller
    /// to have approved this contract first.
    /// @dev Fee-on-transfer and rebasing tokens deliver less than `amountIn` and would
    /// leave the escrow totals overstated. Rejecting them is part of section 8.
    function _pullInput(Currency currency, uint128 amountIn) internal {
        if (currency.isAddressZero()) {
            if (msg.value != amountIn) revert IncorrectNativeValue();
        } else {
            if (msg.value != 0) revert UnexpectedNativeValue();
            ERC20(Currency.unwrap(currency)).safeTransferFrom(msg.sender, address(this), amountIn);
        }
    }

    // --- Hook callbacks ----------------------------------------------------------------

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

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {WalrasHook} from "../src/WalrasHook.sol";
import {MockSettler} from "../src/mocks/MockSettler.sol";

/// @notice The section-1 spike: proves the one assumption the entire Walras design leans
/// on before any escrow/netting/settlement logic gets built on top of it — that a v4
/// hook's `beforeSwap` can reliably tell a legitimate settlement caller apart from anyone
/// else trying to swap directly against the pool, regardless of which router they use.
contract WalrasHookExclusivityTest is Test, Deployers {
    WalrasHook internal hook;
    MockSettler internal settler;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        // The settler stands in for Walras's own settlement path (section 6). It must
        // exist before the hook is deployed, since its address is passed into the hook's
        // constructor as the one caller `beforeSwap` will accept.
        settler = new MockSettler(manager);

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
        bytes memory constructorArgs = abi.encode(manager, address(settler));
        (address hookAddress, bytes32 salt) =
            HookMiner.find(address(this), flags, type(WalrasHook).creationCode, constructorArgs);

        hook = new WalrasHook{salt: salt}(manager, address(settler));
        require(address(hook) == hookAddress, "hook address mismatch");

        (key,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1);

        // Fund the settler so it can settle the swap it's about to execute.
        MockERC20(Currency.unwrap(currency0)).transfer(address(settler), 10 ether);
        MockERC20(Currency.unwrap(currency1)).transfer(address(settler), 10 ether);
    }

    /// @notice PoolManager catches and re-wraps any hook-call revert (ERC-7751 style)
    /// before it reaches the caller, so tests must match that wrapper — not the hook's
    /// raw error — to prove the *right* revert happened, not just *a* revert.
    function _expectWrappedDirectSwapsDisabled() internal {
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeSwap.selector,
                abi.encodeWithSelector(WalrasHook.DirectSwapsDisabled.selector),
                abi.encodePacked(Hooks.HookCallFailed.selector)
            )
        );
    }

    /// @notice Anything that isn't the designated settler — including Uniswap's own
    /// standard test router — must be rejected at the pool level, with no opt-in required.
    function test_RevertsDirectSwapFromStandardRouter() public {
        _expectWrappedDirectSwapsDisabled();
        swap(key, true, -1e15, "");
    }

    /// @notice A swap initiated by the authorized settler must succeed exactly as a normal
    /// swap would — the hook isn't blocking swaps, only the ability to bypass settlement.
    function test_AllowsSwapFromAuthorizedSettler() public {
        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1e15,
            sqrtPriceLimitX96: MIN_PRICE_LIMIT
        });

        settler.executeSwap(key, params);
    }

    /// @notice Confirms rejection isn't router-specific: even a bespoke contract that
    /// calls `PoolManager.swap` directly (no PoolSwapTest involved at all) is blocked
    /// unless it IS the authorized settler.
    function test_RevertsDirectSwapFromArbitraryContract() public {
        MockSettler impostor = new MockSettler(manager);
        MockERC20(Currency.unwrap(currency0)).transfer(address(impostor), 10 ether);
        MockERC20(Currency.unwrap(currency1)).transfer(address(impostor), 10 ether);

        IPoolManager.SwapParams memory params = IPoolManager.SwapParams({
            zeroForOne: true,
            amountSpecified: -1e15,
            sqrtPriceLimitX96: MIN_PRICE_LIMIT
        });

        _expectWrappedDirectSwapsDisabled();
        impostor.executeSwap(key, params);
    }
}

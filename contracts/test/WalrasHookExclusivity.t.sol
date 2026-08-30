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

/// @notice Exclusivity: no swap reaches a Walras-governed pool except the one this hook
/// makes while settling a batch. This began as a section-1 spike against a mock settler
/// passed into the constructor; now that settlement lives in the hook itself, the only
/// authorized caller is the hook, and the positive case — the hook swapping successfully —
/// is covered by the settlement suite. What remains here is the negative half, which is
/// the half that has to hold for the mechanism to mean anything.
contract WalrasHookExclusivityTest is Test, Deployers {
    WalrasHook internal hook;

    /// @dev Short enough to warp past in a test, long enough that ordinary
    /// submissions in the same block never trip a roll.
    uint64 internal constant BATCH_DURATION = 60;
    uint16 internal constant BOUNTY_BIPS = 500;
    uint16 internal constant MAX_ORDERS = 64;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
        bytes memory constructorArgs = abi.encode(manager, BATCH_DURATION, BOUNTY_BIPS, MAX_ORDERS);
        (address hookAddress, bytes32 salt) =
            HookMiner.find(address(this), flags, type(WalrasHook).creationCode, constructorArgs);

        hook = new WalrasHook{salt: salt}(manager, BATCH_DURATION, BOUNTY_BIPS, MAX_ORDERS);
        require(address(hook) == hookAddress, "hook address mismatch");

        (key,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1);
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

    /// @notice Confirms rejection isn't router-specific: even a bespoke contract calling
    /// `PoolManager.swap` directly, with no router involved at all, is blocked. Under the
    /// old design this contract was the one address allowed through; it is now refused
    /// like everything else, which is the point of folding settlement into the hook.
    function test_RevertsDirectSwapFromArbitraryContract() public {
        MockSettler impostor = new MockSettler(manager);
        MockERC20(Currency.unwrap(currency0)).transfer(address(impostor), 10 ether);
        MockERC20(Currency.unwrap(currency1)).transfer(address(impostor), 10 ether);

        IPoolManager.SwapParams memory params =
            IPoolManager.SwapParams({zeroForOne: true, amountSpecified: -1e15, sqrtPriceLimitX96: MIN_PRICE_LIMIT});

        _expectWrappedDirectSwapsDisabled();
        impostor.executeSwap(key, params);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {WalrasHook} from "../src/WalrasHook.sol";
import {DemoToken} from "../src/mocks/DemoToken.sol";
import {Deployments} from "./Deployments.sol";

/// @notice Stands up an entire demonstrable deployment in one transaction batch: two
/// freely mintable tokens, the hook, a pool governed by it, and liquidity to trade against.
///
///   forge script script/DeployDemo.s.sol \
///     --rpc-url unichain_sepolia --broadcast --verify
///
/// The addresses printed at the end are everything a frontend needs. Note that the pool is
/// deliberately unusable through any router or aggregator — that is what the hook enforces,
/// and orders have to go through `submitOrder` instead.
contract DeployDemo is Script {
    using PoolIdLibrary for PoolKey;

    /// @dev A single position spanning the whole range, so pool depth is identical at every
    /// price. The clearing price solves against one liquidity value, which is exact under
    /// that condition and only approximate for a concentrated position.
    int24 internal constant FULL_RANGE_LOWER = -887220;
    int24 internal constant FULL_RANGE_UPPER = 887220;

    uint24 internal constant POOL_FEE = 3000;
    int24 internal constant TICK_SPACING = 60;

    /// @dev Both tokens start at parity, so a balanced batch clears without moving the pool.
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    uint256 internal constant MINT_AMOUNT = 1_000_000 ether;
    int256 internal constant SEED_LIQUIDITY = 1e21;

    function run() external {
        address manager = Deployments.poolManager(block.chainid);

        bytes memory constructorArgs = abi.encode(
            IPoolManager(manager),
            Deployments.BATCH_DURATION,
            Deployments.SETTLEMENT_BOUNTY_BIPS,
            Deployments.MAX_ORDERS_PER_BATCH
        );
        (address expected, bytes32 salt) = HookMiner.find(
            Deployments.CREATE2_DEPLOYER,
            uint160(Hooks.BEFORE_SWAP_FLAG),
            type(WalrasHook).creationCode,
            constructorArgs
        );

        vm.startBroadcast();

        DemoToken tokenA = new DemoToken("Walras Demo A", "WDA");
        DemoToken tokenB = new DemoToken("Walras Demo B", "WDB");

        // v4 requires currency0 < currency1; the tokens land wherever CREATE puts them.
        (DemoToken token0, DemoToken token1) = address(tokenA) < address(tokenB) ? (tokenA, tokenB) : (tokenB, tokenA);

        WalrasHook hook = new WalrasHook{salt: salt}(
            IPoolManager(manager),
            Deployments.BATCH_DURATION,
            Deployments.SETTLEMENT_BOUNTY_BIPS,
            Deployments.MAX_ORDERS_PER_BATCH
        );
        require(address(hook) == expected, "mined address does not match deployment");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(token0)),
            currency1: Currency.wrap(address(token1)),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        IPoolManager(manager).initialize(key, SQRT_PRICE_1_1);

        // Adding liquidity needs a contract that can hold the PoolManager's lock. Uniswap
        // ships one; deploying it here avoids routing the seed through Permit2 and the
        // PositionManager for what is a one-off testnet setup.
        PoolModifyLiquidityTest liquidityRouter = new PoolModifyLiquidityTest(IPoolManager(manager));

        token0.mint(msg.sender, MINT_AMOUNT);
        token1.mint(msg.sender, MINT_AMOUNT);
        token0.approve(address(liquidityRouter), type(uint256).max);
        token1.approve(address(liquidityRouter), type(uint256).max);

        liquidityRouter.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: FULL_RANGE_LOWER,
                tickUpper: FULL_RANGE_UPPER,
                liquidityDelta: SEED_LIQUIDITY,
                salt: 0
            }),
            ""
        );

        // Anyone trading through the hook approves it directly; there is no Permit2 hop.
        token0.approve(address(hook), type(uint256).max);
        token1.approve(address(hook), type(uint256).max);

        vm.stopBroadcast();

        console.log("chain            ", block.chainid);
        console.log("PoolManager      ", manager);
        console.log("WalrasHook       ", address(hook));
        console.log("currency0        ", address(token0));
        console.log("currency1        ", address(token1));
        console.log("liquidity router ", address(liquidityRouter));
        console.log("fee              ", POOL_FEE);
        console.log("tickSpacing      ", uint256(int256(TICK_SPACING)));
        console.log("batch duration   ", Deployments.BATCH_DURATION);
        console.log("poolId           ");
        console.logBytes32(PoolId.unwrap(key.toId()));
    }
}

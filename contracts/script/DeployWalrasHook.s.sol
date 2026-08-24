// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import {WalrasHook} from "../src/WalrasHook.sol";
import {Deployments} from "./Deployments.sol";

/// @notice Deploys the hook alone, against an existing PoolManager.
///
/// A v4 hook's address is not incidental: its low bits declare which callbacks the
/// PoolManager will invoke. Walras needs `beforeSwap`, so the address must carry that flag,
/// which means mining a CREATE2 salt until one produces a matching address. The salt is
/// mined against the CREATE2 proxy rather than against the sender, because that proxy is
/// what will actually perform the deployment — mining against the wrong deployer yields an
/// address whose flags say something else, and the PoolManager rejects the hook outright.
///
///   forge script script/DeployWalrasHook.s.sol \
///     --rpc-url unichain_sepolia --broadcast --verify
contract DeployWalrasHook is Script {
    function run() external returns (WalrasHook hook) {
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
        hook = new WalrasHook{salt: salt}(
            IPoolManager(manager),
            Deployments.BATCH_DURATION,
            Deployments.SETTLEMENT_BOUNTY_BIPS,
            Deployments.MAX_ORDERS_PER_BATCH
        );
        vm.stopBroadcast();

        require(address(hook) == expected, "mined address does not match deployment");

        console.log("chain           ", block.chainid);
        console.log("PoolManager     ", manager);
        console.log("WalrasHook      ", address(hook));
        console.log("batch duration  ", Deployments.BATCH_DURATION);
    }
}

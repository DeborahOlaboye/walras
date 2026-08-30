// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {Deployments} from "./Deployments.sol";

/// @notice Deploys a standard v4 swap router against the live PoolManager.
///
///   forge script script/DeploySwapRouter.s.sol \
///     --rpc-url unichain_sepolia --broadcast --verify
///
/// @dev This exists to be rejected. The frontend's exclusivity proof routes a swap
/// through it so the hook can revert with `DirectSwapsDisabled` — a genuine on-chain
/// revert rather than a scripted animation. Calling `PoolManager.swap` directly from
/// the frontend would instead fail with `ManagerLocked` (the caller holds no lock),
/// which proves nothing about the hook, so a real router that *does* take the lock is
/// the only way to demonstrate the guarantee honestly.
contract DeploySwapRouter is Script {
    function run() external {
        address manager = Deployments.poolManager(block.chainid);

        vm.startBroadcast();
        PoolSwapTest router = new PoolSwapTest(IPoolManager(manager));
        vm.stopBroadcast();

        console.log("chain      ", block.chainid);
        console.log("PoolManager", manager);
        console.log("swap router", address(router));
    }
}

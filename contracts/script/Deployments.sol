// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Where Uniswap v4 lives on each chain this project targets, plus the parameters
/// a Walras hook is deployed with.
library Deployments {
    /// @dev Foundry's deterministic CREATE2 proxy. A hook's address encodes its permission
    /// flags, so it has to be deployed with a mined salt through a known deployer — the
    /// address the salt was mined against must be the one that actually deploys, or the
    /// flags land in the wrong place and the PoolManager rejects the hook.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    uint256 internal constant UNICHAIN = 130;
    uint256 internal constant UNICHAIN_SEPOLIA = 1301;

    /// @notice The v4 PoolManager for the chain being deployed to.
    /// @dev Reverts rather than returning the zero address, so a misconfigured chain fails
    /// at simulation instead of deploying a hook wired to nothing.
    function poolManager(uint256 chainId) internal pure returns (address) {
        if (chainId == UNICHAIN_SEPOLIA) return 0x00B036B58a818B1BC34d502D3fE730Db729e62AC;
        if (chainId == UNICHAIN) return 0x1F98400000000000000000000000000000000004;
        revert("Deployments: no PoolManager known for this chain");
    }

    /// @notice How long a batch accepts orders once its first order arrives.
    /// @dev Twelve seconds on a chain with one-second blocks gathers roughly a dozen blocks
    /// of flow — long enough for two sides to meet, short enough that waiting for a fill
    /// stays tolerable. This is the single most consequential parameter in the deployment:
    /// too short and batches stop netting, too long and nobody wants to trade here.
    uint64 internal constant BATCH_DURATION = 12;

    /// @notice Share of each settlement's surplus paid to whoever triggered it.
    uint16 internal constant SETTLEMENT_BOUNTY_BIPS = 500;

    /// @notice Orders per batch, bounded so settlement cannot outgrow the block gas limit.
    uint16 internal constant MAX_ORDERS_PER_BATCH = 64;
}

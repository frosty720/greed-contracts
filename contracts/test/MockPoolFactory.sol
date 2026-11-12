// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IListedPool {
	function token0() external view returns (address);
	function token1() external view returns (address);
	function tickSpacing() external view returns (int24);
}

/// @notice Stands in for the launchpad's pool factory: it answers `getPool` only for pools it was told it made, in
/// either token order, the way the real factory does.
contract MockPoolFactory {
	mapping(address => mapping(address => mapping(int24 => address))) public getPool;

	function list(address pool) external {
		address token0 = IListedPool(pool).token0();
		address token1 = IListedPool(pool).token1();
		int24 spacing = IListedPool(pool).tickSpacing();
		getPool[token0][token1][spacing] = pool;
		getPool[token1][token0][spacing] = pool;
	}
}

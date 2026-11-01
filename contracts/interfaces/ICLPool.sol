// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The slice of a Uniswap-v3-style pool the buyer uses. Matches Aerodrome Slipstream's CLPool
/// (implementation 0xc770898522d2a9c8da7a10d63989b6b58305b665 on Base, verified on Sourcify) and Uniswap v3.
interface ICLPool {
	function token0() external view returns (address);

	function token1() external view returns (address);

	function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
		external
		returns (int256 amount0, int256 amount1);
}

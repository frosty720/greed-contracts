// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MockSwapPool} from './MockSwapPool.sol';

/// @notice A MockSwapPool that also says which factory made it, its tick spacing and how much liquidity it holds, the
/// things the mainnet route check reads from GREED's pool before anything is deployed against it.
contract MockListedPool is MockSwapPool {
	address public immutable factory;
	int24 public constant tickSpacing = 150;
	uint128 public liquidity;

	constructor(address tokenA, address tokenB, uint256 priceE18_, address factory_, uint128 liquidity_) MockSwapPool(tokenA, tokenB, priceE18_, 10_000) {
		factory = factory_;
		liquidity = liquidity_;
	}

	function setLiquidity(uint128 liquidity_) external {
		liquidity = liquidity_;
	}
}

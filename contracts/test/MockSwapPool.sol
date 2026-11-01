// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

interface ISwapCallback {
	function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @notice A fixed-price stand-in for a Uniswap-v3-style pool: exact-input swaps only, paid through the swap callback.
/// It enforces Uniswap's price-limit rule, so a buyer passing the limit for the wrong side fails here as on a real pool.
contract MockSwapPool {
	uint160 private constant MIN_SQRT_RATIO = 4295128739;
	uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
	uint160 public constant sqrtPriceX96 = 2 ** 96; // a nominal current price between the bounds

	address public immutable token0;
	address public immutable token1;
	uint256 public immutable priceE18; // output per input, scaled by 1e18
	uint256 public fillBps; // share of the input the pool takes, out of 10_000

	constructor(address tokenA, address tokenB, uint256 priceE18_, uint256 fillBps_) {
		(token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
		priceE18 = priceE18_;
		fillBps = fillBps_;
	}

	function setFillBps(uint256 fillBps_) external {
		fillBps = fillBps_;
	}

	function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
		external
		returns (int256 amount0, int256 amount1)
	{
		require(amountSpecified > 0, 'exact input only');
		require(
			zeroForOne
				? sqrtPriceLimitX96 < sqrtPriceX96 && sqrtPriceLimitX96 > MIN_SQRT_RATIO
				: sqrtPriceLimitX96 > sqrtPriceX96 && sqrtPriceLimitX96 < MAX_SQRT_RATIO,
			'SPL'
		);
		(address tokenIn, address tokenOut) = zeroForOne ? (token0, token1) : (token1, token0);
		uint256 amountIn = (uint256(amountSpecified) * fillBps) / 10_000;
		uint256 amountOut = (amountIn * priceE18) / 1e18;
		IERC20(tokenOut).transfer(recipient, amountOut);
		(amount0, amount1) = zeroForOne ? (int256(amountIn), -int256(amountOut)) : (-int256(amountOut), int256(amountIn));
		uint256 before = IERC20(tokenIn).balanceOf(address(this));
		ISwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
		require(IERC20(tokenIn).balanceOf(address(this)) >= before + amountIn, 'input not paid');
	}
}

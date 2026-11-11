// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {SafeCast} from '@openzeppelin/contracts/utils/math/SafeCast.sol';
import {ICLPool} from './interfaces/ICLPool.sol';

/// @title StockRoute
/// @notice The swaps behind GreedBuyer and TokenPay. A pay token reaches the stock GREED is paired with in one or two hops,
/// and the stock buys GREED on GREED's own pool. A game payment is split on the way: a share of the pay token goes to
/// running costs, a share of the stock goes to the treasury for the prize pots, and the rest buys GREED for the treasury.
/// A Shop buy spends everything on GREED. It holds no funds between calls.
abstract contract StockRoute {
	using SafeERC20 for IERC20;

	struct Route {
		address payToken;
		/// @dev Trades the pay token against the stock, or against the middle token when `secondPool` is set.
		address firstPool;
		/// @dev Trades the middle token against the stock; zero for a single hop.
		address secondPool;
		address stock;
		/// @dev Trades the stock against GREED.
		address stockPool;
		address greed;
		address treasury;
		address costs;
		uint256 costsBps;
		uint256 potsBps;
	}

	uint256 private constant BPS = 10_000;
	// TickMath's bounds, one step inside, so a swap may run to the end of the pool's liquidity.
	uint160 private constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
	uint160 private constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;
	/// @dev Any non-empty callback data marks a swap that is only being priced.
	bytes private constant QUOTE = hex'01';

	address public immutable payToken;
	address public immutable stock;
	address public immutable greed;
	address public immutable treasury;
	address public immutable costs;
	uint256 public immutable costsBps;
	uint256 public immutable potsBps;
	ICLPool public immutable firstPool;
	ICLPool public immutable secondPool;
	ICLPool public immutable stockPool;
	bool private immutable firstZeroForOne;
	bool private immutable secondZeroForOne;
	bool private immutable stockZeroForOne;

	error Slippage(uint256 got, uint256 min);
	error PartialFill(uint256 paid, uint256 sent);
	error NotPool();
	error BadPool();
	error BadSplit();
	error ZeroAddress();

	constructor(Route memory r) {
		if (
			r.payToken == address(0) || r.firstPool == address(0) || r.stock == address(0) || r.stockPool == address(0) || r.greed == address(0) || r.treasury == address(0) || r.costs == address(0)
		) revert ZeroAddress();
		if (r.costsBps + r.potsBps >= BPS) revert BadSplit();

		(bool firstDirection, address reached) = _leg(r.firstPool, r.payToken);
		bool secondDirection;
		if (r.secondPool != address(0)) (secondDirection, reached) = _leg(r.secondPool, reached);
		if (reached != r.stock) revert BadPool();
		(bool stockDirection, address bought) = _leg(r.stockPool, r.stock);
		if (bought != r.greed) revert BadPool();

		payToken = r.payToken;
		stock = r.stock;
		greed = r.greed;
		treasury = r.treasury;
		costs = r.costs;
		costsBps = r.costsBps;
		potsBps = r.potsBps;
		firstPool = ICLPool(r.firstPool);
		secondPool = ICLPool(r.secondPool);
		stockPool = ICLPool(r.stockPool);
		firstZeroForOne = firstDirection;
		secondZeroForOne = secondDirection;
		stockZeroForOne = stockDirection;
	}

	/// @notice What a payment of `amountIn` would buy for the treasury. Not a view: call it with eth_call only.
	function quotePay(uint256 amountIn) external returns (uint256 greedOut) {
		uint256 stockOut = _quoteToStock(amountIn - _costsOf(amountIn));
		greedOut = _quoteHop(stockPool, stockZeroForOne, stockOut - _potsOf(stockOut));
	}

	/// @notice What a buy of `amountIn` would get. Not a view: call it with eth_call only.
	function quoteBuy(uint256 amountIn) external returns (uint256 greedOut) {
		greedOut = _quoteHop(stockPool, stockZeroForOne, _quoteToStock(amountIn));
	}

	/// @notice Called by a pool mid-swap: pays what it is owed, or, for a swap that is only being priced, reverts with the amounts.
	function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
		if (msg.sender != address(firstPool) && msg.sender != address(secondPool) && msg.sender != address(stockPool)) revert NotPool();
		if (data.length != 0) {
			(uint256 paid, uint256 got) = amount0Delta > 0 ? (uint256(amount0Delta), uint256(-amount1Delta)) : (uint256(amount1Delta), uint256(-amount0Delta));
			assembly {
				mstore(0x00, paid)
				mstore(0x20, got)
				revert(0x00, 0x40)
			}
		}
		if (amount0Delta > 0) IERC20(ICLPool(msg.sender).token0()).safeTransfer(msg.sender, uint256(amount0Delta));
		if (amount1Delta > 0) IERC20(ICLPool(msg.sender).token1()).safeTransfer(msg.sender, uint256(amount1Delta));
	}

	/// @dev Splits `amountIn` of the pay token, already held here, between costs, the pots and GREED for the treasury.
	function _splitPayment(uint256 amountIn, uint256 minGreedOut) internal returns (uint256 greedOut) {
		uint256 toCosts = _costsOf(amountIn);
		if (toCosts > 0) IERC20(payToken).safeTransfer(costs, toCosts);
		uint256 stockOut = _toStock(amountIn - toCosts);
		uint256 toPots = _potsOf(stockOut);
		if (toPots > 0) IERC20(stock).safeTransfer(treasury, toPots);
		greedOut = _toGreed(stockOut - toPots, treasury, minGreedOut);
	}

	/// @dev Spends all of `amountIn` of the pay token, already held here, on GREED for `to`.
	function _buyGreed(uint256 amountIn, address to, uint256 minGreedOut) internal returns (uint256 greedOut) {
		greedOut = _toGreed(_toStock(amountIn), to, minGreedOut);
	}

	function _costsOf(uint256 amountIn) private view returns (uint256) {
		return (amountIn * costsBps) / BPS;
	}

	/// @dev The pots' share of the stock: `potsBps` of the whole payment, out of the part that wasn't taken for costs.
	function _potsOf(uint256 stockOut) private view returns (uint256) {
		return (stockOut * potsBps) / (BPS - costsBps);
	}

	function _toStock(uint256 amountIn) private returns (uint256 stockOut) {
		stockOut = _swap(firstPool, firstZeroForOne, amountIn, address(this));
		if (address(secondPool) != address(0)) stockOut = _swap(secondPool, secondZeroForOne, stockOut, address(this));
	}

	function _toGreed(uint256 stockIn, address recipient, uint256 minGreedOut) private returns (uint256 greedOut) {
		greedOut = _swap(stockPool, stockZeroForOne, stockIn, recipient);
		if (greedOut < minGreedOut) revert Slippage(greedOut, minGreedOut);
	}

	function _swap(ICLPool pool, bool zeroForOne, uint256 amountIn, address recipient) private returns (uint256 amountOut) {
		int256 exactIn = SafeCast.toInt256(amountIn);
		(int256 amount0, int256 amount1) = pool.swap(recipient, zeroForOne, exactIn, _limit(zeroForOne), '');
		(int256 paidLeg, int256 gotLeg) = zeroForOne ? (amount0, amount1) : (amount1, amount0);
		if (paidLeg != exactIn) revert PartialFill(paidLeg > 0 ? uint256(paidLeg) : 0, amountIn);
		amountOut = gotLeg < 0 ? uint256(-gotLeg) : 0;
	}

	function _quoteToStock(uint256 amountIn) private returns (uint256 stockOut) {
		stockOut = _quoteHop(firstPool, firstZeroForOne, amountIn);
		if (address(secondPool) != address(0)) stockOut = _quoteHop(secondPool, secondZeroForOne, stockOut);
	}

	/// @dev Starts the swap and catches the callback's revert, so nothing moves. Any other revert is the pool's own and is passed on.
	function _quoteHop(ICLPool pool, bool zeroForOne, uint256 amountIn) private returns (uint256 amountOut) {
		try pool.swap(address(this), zeroForOne, SafeCast.toInt256(amountIn), _limit(zeroForOne), QUOTE) {
			revert NotPool();
		} catch (bytes memory reason) {
			if (reason.length != 64) {
				assembly {
					revert(add(reason, 0x20), mload(reason))
				}
			}
			uint256 paid;
			(paid, amountOut) = abi.decode(reason, (uint256, uint256));
			if (paid != amountIn) revert PartialFill(paid, amountIn);
		}
	}

	function _limit(bool zeroForOne) private pure returns (uint160) {
		return zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE;
	}

	/// @dev Which way `tokenIn` trades on `pool` and what it buys; a pool that doesn't hold it is refused.
	function _leg(address pool, address tokenIn) private view returns (bool zeroForOne, address tokenOut) {
		address t0 = ICLPool(pool).token0();
		address t1 = ICLPool(pool).token1();
		if (tokenIn != t0 && tokenIn != t1) revert BadPool();
		zeroForOne = tokenIn == t0;
		tokenOut = zeroForOne ? t1 : t0;
	}
}

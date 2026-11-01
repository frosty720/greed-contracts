// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {ICLPool} from './interfaces/ICLPool.sol';
import {IWETH} from './interfaces/IWETH.sol';

/// @title GreedBuyer
/// @notice Turns ETH into GREED on the coin's own pool in one call. `pay` sends the GREED to the treasury for a
/// game action; `buy` sends it to a wallet for the Shop. Nothing is minted, and the contract holds no funds between calls.
contract GreedBuyer is ReentrancyGuard {
	using SafeERC20 for IERC20;

	// TickMath's bounds, one step inside, so a swap may run to the end of the pool's liquidity.
	uint160 private constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
	uint160 private constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

	address public immutable weth;
	address public immutable greed;
	ICLPool public immutable pool;
	address public immutable treasury;
	bool public immutable wethIsToken0;

	event Paid(address indexed payer, bytes32 indexed quoteId, uint256 ethIn, uint256 greedOut);
	event Bought(address indexed payer, address indexed to, uint256 ethIn, uint256 greedOut);

	error ZeroValue();
	error Slippage(uint256 got, uint256 min);
	error PartialFill(uint256 paid, uint256 sent);
	error NotPool();
	error BadPool();
	error ZeroAddress();
	error BadRecipient();

	constructor(address weth_, address greed_, address pool_, address treasury_) {
		if (weth_ == address(0) || greed_ == address(0) || pool_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
		address t0 = ICLPool(pool_).token0();
		address t1 = ICLPool(pool_).token1();
		if (!((t0 == weth_ && t1 == greed_) || (t0 == greed_ && t1 == weth_))) revert BadPool();
		weth = weth_;
		greed = greed_;
		pool = ICLPool(pool_);
		treasury = treasury_;
		wethIsToken0 = t0 == weth_;
	}

	/// @notice Pays for a game action: all of msg.value buys GREED for the treasury.
	function pay(bytes32 quoteId, uint256 minGreedOut) external payable nonReentrant returns (uint256 greedOut) {
		greedOut = _swap(treasury, minGreedOut);
		emit Paid(msg.sender, quoteId, msg.value, greedOut);
	}

	/// @notice Buys GREED for a wallet.
	function buy(address to, uint256 minGreedOut) external payable nonReentrant returns (uint256 greedOut) {
		if (to == address(0)) revert ZeroAddress();
		if (to == address(this)) revert BadRecipient();
		greedOut = _swap(to, minGreedOut);
		emit Bought(msg.sender, to, msg.value, greedOut);
	}

	/// @notice Called by the pool mid-swap: pays it the WETH it is owed. Runs inside a guarded pay/buy.
	function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
		if (msg.sender != address(pool)) revert NotPool();
		int256 owed = wethIsToken0 ? amount0Delta : amount1Delta;
		if (owed > 0) IERC20(weth).safeTransfer(msg.sender, uint256(owed));
	}

	function _swap(address recipient, uint256 minGreedOut) private returns (uint256 greedOut) {
		if (msg.value == 0) revert ZeroValue();
		IWETH(weth).deposit{value: msg.value}();
		bool zeroForOne = wethIsToken0;
		(int256 amount0, int256 amount1) = pool.swap(
			recipient,
			zeroForOne,
			int256(msg.value),
			zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
			''
		);
		(int256 wethLeg, int256 greedLeg) = wethIsToken0 ? (amount0, amount1) : (amount1, amount0);
		if (wethLeg != int256(msg.value)) revert PartialFill(wethLeg > 0 ? uint256(wethLeg) : 0, msg.value);
		greedOut = greedLeg < 0 ? uint256(-greedLeg) : 0;
		if (greedOut < minGreedOut) revert Slippage(greedOut, minGreedOut);
	}
}

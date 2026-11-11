// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {StockRoute} from './StockRoute.sol';

/// @title TokenPay
/// @notice Pays for a game action in USDC or GREED, and buys GREED with USDC for the Shop. `payUsdc` splits a payment between
/// costs, the prize pots and GREED for the treasury; `payGreed` sends GREED straight to the treasury; `buyUsdc` buys GREED for a
/// wallet. ETH stays with GreedBuyer. It only ever takes from the caller, has no owner, and holds no funds between calls.
contract TokenPay is ReentrancyGuard, StockRoute {
	using SafeERC20 for IERC20;

	/// @param token What the payer paid in; `greedOut` is what it bought, 0 for a GREED payment.
	event TokenPaid(address indexed payer, bytes32 indexed quoteId, address indexed token, uint256 amountIn, uint256 greedOut);
	event TokenBought(address indexed payer, address indexed to, uint256 usdcIn, uint256 greedOut);

	error ZeroAmount();
	error BadRecipient();

	/// @param route `payToken` is USDC.
	constructor(Route memory route) StockRoute(route) {}

	/// @notice The USDC this contract takes.
	function usdc() external view returns (address) {
		return payToken;
	}

	/// @notice Pays for a game action in USDC. Needs an allowance.
	function payUsdc(bytes32 quoteId, uint256 usdcIn, uint256 minGreedOut) external nonReentrant returns (uint256 greedOut) {
		_takeUsdc(usdcIn);
		greedOut = _splitPayment(usdcIn, minGreedOut);
		emit TokenPaid(msg.sender, quoteId, payToken, usdcIn, greedOut);
	}

	/// @notice Buys GREED with USDC for a wallet, for the Shop. Needs an allowance.
	function buyUsdc(address to, uint256 usdcIn, uint256 minGreedOut) external nonReentrant returns (uint256 greedOut) {
		if (to == address(0)) revert ZeroAddress();
		if (to == address(this)) revert BadRecipient();
		_takeUsdc(usdcIn);
		greedOut = _buyGreed(usdcIn, to, minGreedOut);
		emit TokenBought(msg.sender, to, usdcIn, greedOut);
	}

	/// @notice Pays for a game action in GREED: all of `greedIn` goes to the treasury, nothing is bought. Needs an allowance.
	function payGreed(bytes32 quoteId, uint256 greedIn) external nonReentrant {
		if (greedIn == 0) revert ZeroAmount();
		IERC20(greed).safeTransferFrom(msg.sender, treasury, greedIn);
		emit TokenPaid(msg.sender, quoteId, greed, greedIn, 0);
	}

	function _takeUsdc(uint256 usdcIn) private {
		if (usdcIn == 0) revert ZeroAmount();
		IERC20(payToken).safeTransferFrom(msg.sender, address(this), usdcIn);
	}
}

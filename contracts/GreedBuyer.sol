// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {IWETH} from './interfaces/IWETH.sol';
import {StockRoute} from './StockRoute.sol';

/// @title GreedBuyer
/// @notice Takes ETH as WETH down the coin's route in one call. `pay` splits a game payment between costs, the prize pots and
/// GREED for the treasury; `buy` spends it all on GREED for a wallet, for the Shop. Nothing is minted, and the contract holds
/// no funds between calls.
contract GreedBuyer is ReentrancyGuard, StockRoute {
	event Paid(address indexed payer, bytes32 indexed quoteId, uint256 ethIn, uint256 greedOut);
	event Bought(address indexed payer, address indexed to, uint256 ethIn, uint256 greedOut);

	error ZeroValue();
	error BadRecipient();

	/// @param route `payToken` is WETH.
	constructor(Route memory route) StockRoute(route) {}

	/// @notice Pays for a game action. Costs are paid in WETH.
	function pay(bytes32 quoteId, uint256 minGreedOut) external payable nonReentrant returns (uint256 greedOut) {
		_wrap();
		greedOut = _splitPayment(msg.value, minGreedOut);
		emit Paid(msg.sender, quoteId, msg.value, greedOut);
	}

	/// @notice Buys GREED for a wallet.
	function buy(address to, uint256 minGreedOut) external payable nonReentrant returns (uint256 greedOut) {
		if (to == address(0)) revert ZeroAddress();
		if (to == address(this)) revert BadRecipient();
		_wrap();
		greedOut = _buyGreed(msg.value, to, minGreedOut);
		emit Bought(msg.sender, to, msg.value, greedOut);
	}

	function _wrap() private {
		if (msg.value == 0) revert ZeroValue();
		IWETH(payToken).deposit{value: msg.value}();
	}
}

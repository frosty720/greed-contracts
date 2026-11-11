// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';

/// @notice Testnet stand-in for USDC: 6 decimals, and anyone can mint, so test wallets can pay with it. A mint is capped so
/// no wallet can build a payment big enough to overflow the game's credit arithmetic.
contract MockUSDC is ERC20 {
	uint256 public constant MAX_MINT = 10_000e6;

	error MintTooBig(uint256 amount, uint256 max);

	constructor() ERC20('USD Coin (Test)', 'tUSDC') {}

	function decimals() public pure override returns (uint8) {
		return 6;
	}

	function mint(address to, uint256 amount) external {
		if (amount > MAX_MINT) revert MintTooBig(amount, MAX_MINT);
		_mint(to, amount);
	}
}

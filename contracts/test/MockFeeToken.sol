// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';

/// @notice A token that takes 1% of every transfer, to prove the prize pool refuses short funding.
contract MockFeeToken is ERC20 {
	constructor() ERC20('Mock Fee Token', 'MFEE') {
		_mint(msg.sender, 1_000_000e18);
	}

	function _update(address from, address to, uint256 value) internal override {
		if (from == address(0) || to == address(0)) return super._update(from, to, value);
		uint256 fee = value / 100;
		super._update(from, address(0), fee);
		super._update(from, to, value - fee);
	}
}

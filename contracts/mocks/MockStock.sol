// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';

/// @notice Testnet stand-in for a tokenized stock the GREED index pays out. 8 decimals, like the real ones.
contract MockStock is ERC20, Ownable {
	constructor(string memory name_, string memory symbol_, address owner_) ERC20(name_, symbol_) Ownable(owner_) {}

	function decimals() public pure override returns (uint8) {
		return 8;
	}

	/// @notice Stands in for a Stockify harvest landing in the treasury.
	function mint(address to, uint256 amount) external onlyOwner {
		_mint(to, amount);
	}
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';

/// @notice Testnet stand-in for GREED: a fixed 1B supply minted once to the deployer, like a Stonks launch.
contract MockGreed is ERC20 {
	constructor() ERC20('Greed is Good (Test)', 'tGREED') {
		_mint(msg.sender, 1_000_000_000e18);
	}
}

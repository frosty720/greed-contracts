// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

interface IPayUsdc {
	function payUsdc(bytes32 quoteId, uint256 usdcIn, uint256 minGreedOut) external returns (uint256 greedOut);
}

/// @notice Simulation only, never deployed. The deploy check lends this code to an address that already holds USDC,
/// inside one eth_call, so a whole USDC payment runs against live state: approve, pull, split and both swaps.
contract SimPayer {
	using SafeERC20 for IERC20;

	function payUsdc(address usdc, address tokenPay, uint256 amount) external returns (uint256) {
		IERC20(usdc).forceApprove(tokenPay, amount);
		return IPayUsdc(tokenPay).payUsdc(keccak256('simulated'), amount, 0);
	}
}

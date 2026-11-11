// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Test double with the two Safe views the mainnet deploy script reads.
contract MockSafe {
	address[] private owners;
	uint256 private immutable threshold;

	constructor(address[] memory owners_, uint256 threshold_) {
		owners = owners_;
		threshold = threshold_;
	}

	function getOwners() external view returns (address[] memory) {
		return owners;
	}

	function getThreshold() external view returns (uint256) {
		return threshold;
	}
}

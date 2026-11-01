// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice WETH9-like test token. It keeps no constructor state, so its runtime code can be placed at any address with hardhat_setCode.
contract MockWETH {
	mapping(address => uint256) public balanceOf;
	mapping(address => mapping(address => uint256)) public allowance;

	event Transfer(address indexed from, address indexed to, uint256 value);
	event Approval(address indexed owner, address indexed spender, uint256 value);

	function name() external pure returns (string memory) {
		return 'Wrapped Ether (Mock)';
	}

	function symbol() external pure returns (string memory) {
		return 'mWETH';
	}

	function decimals() external pure returns (uint8) {
		return 18;
	}

	function totalSupply() external view returns (uint256) {
		return address(this).balance;
	}

	function deposit() external payable {
		balanceOf[msg.sender] += msg.value;
		emit Transfer(address(0), msg.sender, msg.value);
	}

	function approve(address spender, uint256 value) external returns (bool) {
		allowance[msg.sender][spender] = value;
		emit Approval(msg.sender, spender, value);
		return true;
	}

	function transfer(address to, uint256 value) external returns (bool) {
		return _move(msg.sender, to, value);
	}

	function transferFrom(address from, address to, uint256 value) external returns (bool) {
		if (from != msg.sender) allowance[from][msg.sender] -= value;
		return _move(from, to, value);
	}

	function _move(address from, address to, uint256 value) private returns (bool) {
		balanceOf[from] -= value;
		balanceOf[to] += value;
		emit Transfer(from, to, value);
		return true;
	}
}

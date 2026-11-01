// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {Ownable2Step} from '@openzeppelin/contracts/access/Ownable2Step.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {MerkleProof} from '@openzeppelin/contracts/utils/cryptography/MerkleProof.sol';

/// @title PrizePool
/// @notice Holds each payout round's stock prizes and pays winners against a Merkle root. Only the owner (the
/// treasury Safe) posts and funds rounds. A leaf is the StandardMerkleTree encoding of
/// (uint256 roundId, address account, address[] tokens, uint256[] amounts), so a winner claims every token in one call.
/// Each round's money is tracked on its own, so a tree that over-allocates can never spend another round's prizes.
/// Ownership moves in two steps and can't be renounced, so sweeps always have a live owner to return to.
/// Known limit: a token whose balances rebase (for example a stock split applied as a rebase) is not supported.
contract PrizePool is Ownable2Step, ReentrancyGuard {
	using SafeERC20 for IERC20;

	struct Round {
		bytes32 root;
		uint64 expiresAt;
	}

	uint64 public immutable claimWindow;
	mapping(uint256 => Round) public rounds;
	mapping(uint256 => mapping(address => uint256)) public remaining;
	mapping(uint256 => mapping(address => bool)) public claimed;

	event RoundPosted(uint256 indexed roundId, bytes32 root, uint64 expiresAt);
	event Claimed(uint256 indexed roundId, address indexed account, address[] tokens, uint256[] amounts);
	event Swept(uint256 indexed roundId, address indexed token, uint256 amount);

	error RoundExists(uint256 roundId);
	error ZeroRoot();
	error LengthMismatch();
	error UnknownRound(uint256 roundId);
	error Expired(uint256 roundId);
	error AlreadyClaimed(uint256 roundId, address account);
	error InvalidProof();
	error NotExpired(uint256 roundId);
	error ShortFunding(address token, uint256 expected, uint256 received);
	error RenounceDisabled();

	constructor(address initialOwner, uint64 claimWindow_) Ownable(initialOwner) {
		claimWindow = claimWindow_;
	}

	/// @notice Posts a round's root and pulls its prize totals from the owner in the same call.
	function postRound(uint256 roundId, bytes32 root, address[] calldata tokens, uint256[] calldata totals) external onlyOwner {
		if (rounds[roundId].root != bytes32(0)) revert RoundExists(roundId);
		if (root == bytes32(0)) revert ZeroRoot();
		if (tokens.length != totals.length) revert LengthMismatch();
		uint64 expiresAt = uint64(block.timestamp) + claimWindow;
		rounds[roundId] = Round(root, expiresAt);
		for (uint256 i; i < tokens.length; ++i) {
			remaining[roundId][tokens[i]] += totals[i];
			IERC20 token = IERC20(tokens[i]);
			uint256 before = token.balanceOf(address(this));
			token.safeTransferFrom(msg.sender, address(this), totals[i]);
			uint256 received = token.balanceOf(address(this)) - before;
			// A token that takes a fee on transfer would leave this round short and pay its last winners from other rounds.
			if (received < totals[i]) revert ShortFunding(tokens[i], totals[i], received);
		}
		emit RoundPosted(roundId, root, expiresAt);
	}

	/// @notice Pays the caller every token in their leaf for this round.
	function claim(uint256 roundId, address[] calldata tokens, uint256[] calldata amounts, bytes32[] calldata proof)
		external
		nonReentrant
	{
		Round memory round = rounds[roundId];
		if (round.root == bytes32(0)) revert UnknownRound(roundId);
		if (block.timestamp > round.expiresAt) revert Expired(roundId);
		if (claimed[roundId][msg.sender]) revert AlreadyClaimed(roundId, msg.sender);
		if (tokens.length != amounts.length) revert LengthMismatch();
		bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(roundId, msg.sender, tokens, amounts))));
		if (!MerkleProof.verifyCalldata(proof, round.root, leaf)) revert InvalidProof();
		claimed[roundId][msg.sender] = true;
		for (uint256 i; i < tokens.length; ++i) {
			remaining[roundId][tokens[i]] -= amounts[i];
			IERC20(tokens[i]).safeTransfer(msg.sender, amounts[i]);
		}
		emit Claimed(roundId, msg.sender, tokens, amounts);
	}

	/// @notice After a round expires, anyone may return its unclaimed prizes to the owner.
	function sweep(uint256 roundId, address[] calldata tokens) external {
		Round memory round = rounds[roundId];
		if (round.root == bytes32(0)) revert UnknownRound(roundId);
		if (block.timestamp <= round.expiresAt) revert NotExpired(roundId);
		for (uint256 i; i < tokens.length; ++i) {
			uint256 amount = remaining[roundId][tokens[i]];
			remaining[roundId][tokens[i]] = 0;
			IERC20(tokens[i]).safeTransfer(owner(), amount);
			emit Swept(roundId, tokens[i], amount);
		}
	}

	/// @notice Disabled: with no owner, sweeps would send unclaimed prizes to the zero address and lock them forever.
	function renounceOwnership() public pure override {
		revert RenounceDisabled();
	}
}

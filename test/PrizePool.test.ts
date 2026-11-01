import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';

const TYPES = ['uint256', 'address', 'address[]', 'uint256[]'];
const WINDOW = 2_419_200n; // 28 days

type Entry = [account: string, tokens: string[], amounts: bigint[]];
type Leaf = [roundId: bigint, account: string, tokens: string[], amounts: bigint[]];

function buildTree(roundId: bigint, entries: Entry[]): StandardMerkleTree<Leaf> {
	return StandardMerkleTree.of(
		entries.map(([account, tokens, amounts]): Leaf => [roundId, account, tokens, amounts]),
		TYPES,
	);
}

function proofFor(tree: StandardMerkleTree<Leaf>, account: string): string[] {
	for (const [i, value] of tree.entries()) {
		if (value[1] === account) return tree.getProof(i);
	}
	throw new Error(`no leaf for ${account}`);
}

async function deploy() {
	const [owner, alice, bob] = await ethers.getSigners();
	const pool = await ethers.deployContract('PrizePool', [owner.address, WINDOW]);
	const s1 = await ethers.deployContract('MockStock', ['Mock Stock Alpha', 'MSKA', owner.address]);
	const s2 = await ethers.deployContract('MockStock', ['Mock Stock Beta', 'MSKB', owner.address]);
	for (const s of [s1, s2]) {
		await s.mint(owner.address, 10_000n);
		await s.approve(await pool.getAddress(), ethers.MaxUint256);
	}
	return { owner, alice, bob, pool, s1, s2, a1: await s1.getAddress(), a2: await s2.getAddress() };
}

describe('PrizePool', () => {
	it('only the owner can post a round, and it pulls the exact totals', async () => {
		const { alice, pool, s1, s2, a1, a2 } = await deploy();
		const tree = buildTree(1n, [[alice.address, [a1, a2], [100n, 7n]]]);
		await expect(pool.connect(alice).postRound(1, tree.root, [a1, a2], [100n, 7n]))
			.to.be.revertedWithCustomError(pool, 'OwnableUnauthorizedAccount')
			.withArgs(alice.address);
		const tx = await pool.postRound(1, tree.root, [a1, a2], [100n, 7n]);
		const ts = BigInt((await ethers.provider.getBlock((await tx.wait())!.blockNumber))!.timestamp);
		await expect(tx).to.emit(pool, 'RoundPosted').withArgs(1n, tree.root, ts + WINDOW);
		expect(await s1.balanceOf(await pool.getAddress())).to.equal(100n);
		expect(await s2.balanceOf(await pool.getAddress())).to.equal(7n);
		expect(await pool.remaining(1, a1)).to.equal(100n);
		const [root, expiresAt] = await pool.rounds(1);
		expect(root).to.equal(tree.root);
		expect(expiresAt).to.equal(ts + WINDOW);
	});

	it('rejects a second post of the same round id', async () => {
		const { alice, pool, a1 } = await deploy();
		const tree = buildTree(1n, [[alice.address, [a1], [1n]]]);
		await pool.postRound(1, tree.root, [a1], [1n]);
		await expect(pool.postRound(1, tree.root, [a1], [1n])).to.be.revertedWithCustomError(pool, 'RoundExists').withArgs(1n);
	});

	it('rejects a zero root or mismatched lists when posting', async () => {
		const { pool, a1 } = await deploy();
		await expect(pool.postRound(1, ethers.ZeroHash, [a1], [1n])).to.be.revertedWithCustomError(pool, 'ZeroRoot');
		await expect(pool.postRound(1, ethers.id('root'), [a1], [1n, 2n])).to.be.revertedWithCustomError(pool, 'LengthMismatch');
	});

	it('pays a winner two stock tokens in one claim', async () => {
		const { alice, bob, pool, s1, s2, a1, a2 } = await deploy();
		const tree = buildTree(1n, [
			[alice.address, [a1, a2], [100n, 7n]],
			[bob.address, [a1], [20n]],
		]);
		await pool.postRound(1, tree.root, [a1, a2], [120n, 7n]);
		await expect(pool.connect(alice).claim(1, [a1, a2], [100n, 7n], proofFor(tree, alice.address)))
			.to.emit(pool, 'Claimed')
			.withArgs(1n, alice.address, [a1, a2], [100n, 7n]);
		expect(await s1.balanceOf(alice.address)).to.equal(100n);
		expect(await s2.balanceOf(alice.address)).to.equal(7n);
		expect(await pool.claimed(1, alice.address)).to.equal(true);
		expect(await pool.remaining(1, a1)).to.equal(20n);
	});

	it('rejects a second claim', async () => {
		const { alice, pool, a1 } = await deploy();
		const tree = buildTree(1n, [[alice.address, [a1], [50n]], [ethers.ZeroAddress, [a1], [50n]]]);
		await pool.postRound(1, tree.root, [a1], [100n]);
		const proof = proofFor(tree, alice.address);
		await pool.connect(alice).claim(1, [a1], [50n], proof);
		await expect(pool.connect(alice).claim(1, [a1], [50n], proof))
			.to.be.revertedWithCustomError(pool, 'AlreadyClaimed')
			.withArgs(1n, alice.address);
	});

	it("rejects someone claiming another winner's leaf or a changed amount", async () => {
		const { alice, bob, pool, a1 } = await deploy();
		const tree = buildTree(1n, [[alice.address, [a1], [100n]], [bob.address, [a1], [1n]]]);
		await pool.postRound(1, tree.root, [a1], [101n]);
		const aliceProof = proofFor(tree, alice.address);
		await expect(pool.connect(bob).claim(1, [a1], [100n], aliceProof)).to.be.revertedWithCustomError(pool, 'InvalidProof');
		await expect(pool.connect(alice).claim(1, [a1], [101n], aliceProof)).to.be.revertedWithCustomError(pool, 'InvalidProof');
	});

	it('rejects unknown rounds and mismatched claim lists', async () => {
		const { alice, pool, a1, a2 } = await deploy();
		await expect(pool.connect(alice).claim(9, [a1], [1n], [])).to.be.revertedWithCustomError(pool, 'UnknownRound').withArgs(9n);
		const tree = buildTree(1n, [[alice.address, [a1], [1n]], [ethers.ZeroAddress, [a1], [1n]]]);
		await pool.postRound(1, tree.root, [a1], [2n]);
		await expect(pool.connect(alice).claim(1, [a1, a2], [1n], [])).to.be.revertedWithCustomError(pool, 'LengthMismatch');
	});

	it('cannot pay out more than the round was funded with', async () => {
		const { alice, bob, pool, a1 } = await deploy();
		const greedy = buildTree(1n, [[alice.address, [a1], [100n]], [bob.address, [a1], [50n]]]);
		await pool.postRound(1, greedy.root, [a1], [100n]);
		const other = buildTree(2n, [[alice.address, [a1], [1_000n]], [ethers.ZeroAddress, [a1], [1n]]]);
		await pool.postRound(2, other.root, [a1], [1_000n]);
		await pool.connect(alice).claim(1, [a1], [100n], proofFor(greedy, alice.address));
		await expect(pool.connect(bob).claim(1, [a1], [50n], proofFor(greedy, bob.address))).to.be.revertedWithPanic(0x11);
		expect(await pool.remaining(2, a1)).to.equal(1_000n);
	});

	it('rejects claims after expiry and after a sweep', async () => {
		const { alice, bob, pool, a1 } = await deploy();
		const tree = buildTree(1n, [[alice.address, [a1], [10n]], [bob.address, [a1], [10n]]]);
		await pool.postRound(1, tree.root, [a1], [20n]);
		const [, expiresAt] = await pool.rounds(1);
		await time.increaseTo(expiresAt + 1n);
		await expect(pool.connect(alice).claim(1, [a1], [10n], proofFor(tree, alice.address)))
			.to.be.revertedWithCustomError(pool, 'Expired')
			.withArgs(1n);
		await pool.sweep(1, [a1]);
		await expect(pool.connect(bob).claim(1, [a1], [10n], proofFor(tree, bob.address)))
			.to.be.revertedWithCustomError(pool, 'Expired')
			.withArgs(1n);
	});

	it('sweeps only after expiry and only to the owner', async () => {
		const { owner, alice, bob, pool, s1, a1 } = await deploy();
		const tree = buildTree(1n, [[alice.address, [a1], [30n]], [bob.address, [a1], [70n]]]);
		await pool.postRound(1, tree.root, [a1], [100n]);
		await pool.connect(alice).claim(1, [a1], [30n], proofFor(tree, alice.address));
		await expect(pool.connect(bob).sweep(1, [a1])).to.be.revertedWithCustomError(pool, 'NotExpired').withArgs(1n);
		const [, expiresAt] = await pool.rounds(1);
		await time.increaseTo(expiresAt + 1n);
		const before = await s1.balanceOf(owner.address);
		await expect(pool.connect(bob).sweep(1, [a1])).to.emit(pool, 'Swept').withArgs(1n, a1, 70n);
		expect(await s1.balanceOf(owner.address)).to.equal(before + 70n);
		expect(await s1.balanceOf(bob.address)).to.equal(0n);
		expect(await pool.remaining(1, a1)).to.equal(0n);
	});

	it('rejects a sweep of a round that was never posted', async () => {
		const { pool, a1 } = await deploy();
		await expect(pool.sweep(9, [a1])).to.be.revertedWithCustomError(pool, 'UnknownRound').withArgs(9n);
	});

	it('pays a claim made at exactly expiresAt', async () => {
		const { alice, pool, s1, a1 } = await deploy();
		const tree = buildTree(1n, [[alice.address, [a1], [10n]], [ethers.ZeroAddress, [a1], [1n]]]);
		await pool.postRound(1, tree.root, [a1], [11n]);
		const [, expiresAt] = await pool.rounds(1);
		await time.setNextBlockTimestamp(expiresAt);
		await pool.connect(alice).claim(1, [a1], [10n], proofFor(tree, alice.address));
		expect(await s1.balanceOf(alice.address)).to.equal(10n);
	});

	it('refuses a sweep at exactly expiresAt', async () => {
		const { alice, pool, a1 } = await deploy();
		const tree = buildTree(1n, [[alice.address, [a1], [10n]], [ethers.ZeroAddress, [a1], [1n]]]);
		await pool.postRound(1, tree.root, [a1], [11n]);
		const [, expiresAt] = await pool.rounds(1);
		await time.setNextBlockTimestamp(expiresAt);
		await expect(pool.sweep(1, [a1])).to.be.revertedWithCustomError(pool, 'NotExpired').withArgs(1n);
	});

	it('hands ownership over only when the new owner accepts', async () => {
		const { owner, alice, pool } = await deploy();
		await pool.transferOwnership(alice.address);
		expect(await pool.owner()).to.equal(owner.address);
		expect(await pool.pendingOwner()).to.equal(alice.address);
		await pool.connect(alice).acceptOwnership();
		expect(await pool.owner()).to.equal(alice.address);
	});

	it('refuses to renounce ownership, which would lock unclaimed prizes forever', async () => {
		const { pool } = await deploy();
		await expect(pool.renounceOwnership()).to.be.revertedWithCustomError(pool, 'RenounceDisabled');
	});

	it('refuses a token that arrives short, so rounds never share money', async () => {
		const { alice, pool } = await deploy();
		const fee = await ethers.deployContract('MockFeeToken');
		const feeAddr = await fee.getAddress();
		await fee.approve(await pool.getAddress(), ethers.MaxUint256);
		const tree = buildTree(1n, [[alice.address, [feeAddr], [1_000n]], [ethers.ZeroAddress, [feeAddr], [1n]]]);
		await expect(pool.postRound(1, tree.root, [feeAddr], [1_000n]))
			.to.be.revertedWithCustomError(pool, 'ShortFunding')
			.withArgs(feeAddr, 1_000n, 990n);
	});
});

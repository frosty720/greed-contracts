import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { Signer } from 'ethers';
import { ethers, network } from 'hardhat';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { LEAF_TYPES, Winner, buildLeaves } from './lib/prize-tree';
import { loadDeployment } from './lib/sepolia';

/**
 * Builds one prize round: the Merkle tree, every winner's proof, and the Safe batch (approve each token, then postRound).
 * With EXECUTE=1 a treasury that is a plain wallet (the testnet setup) sends the same calls itself, after the same checks.
 */

type Call = { to: string; data: string; signature: string };
type SimulatedCall = { status: string };

const OUT = path.join(__dirname, '..', 'out');

/** Standing rule: every raw call's selector is checked against `cast sig` before it reaches the Safe. */
function checkSelector(call: Call): void {
	const fromCast = execFileSync('cast', ['sig', call.signature], { encoding: 'utf8' }).trim();
	const fromData = call.data.slice(0, 10);
	console.log(`${call.signature}: calldata ${fromData}, cast sig ${fromCast}`);
	if (fromCast !== fromData) throw new Error(`selector mismatch for ${call.signature}`);
}

/** Runs the batch in order as the Safe. On a local fork it impersonates and rolls back; on Base Sepolia it uses eth_simulateV1. */
async function simulate(from: string, calls: Call[]): Promise<void> {
	if (network.name === 'localhost' || network.name === 'hardhat') {
		const snapshot: string = await network.provider.send('evm_snapshot', []);
		await network.provider.send('hardhat_impersonateAccount', [from]);
		await network.provider.send('hardhat_setBalance', [from, '0x56BC75E2D63100000']);
		const safe = await ethers.getSigner(from);
		try {
			for (const c of calls) {
				await (await safe.sendTransaction({ to: c.to, data: c.data })).wait();
				console.log(`simulated ${c.signature}: ok`);
			}
		} finally {
			await network.provider.send('evm_revert', [snapshot]);
		}
		return;
	}
	const result: { calls: SimulatedCall[] }[] = await ethers.provider.send('eth_simulateV1', [
		{ blockStateCalls: [{ calls: calls.map((c) => ({ from, to: c.to, data: c.data })) }] },
		'latest',
	]);
	calls.forEach((c, i) => {
		const status = result[0].calls[i].status;
		console.log(`simulated ${c.signature}: status ${status}`);
		if (status !== '0x1') throw new Error(`simulation reverted at ${c.signature}`);
	});
}

/** The treasury wallet's signer: TREASURY_PRIVATE_KEY, or one of the network's own accounts (the deployer on testnet). */
async function treasurySigner(treasury: string): Promise<Signer> {
	const key = process.env.TREASURY_PRIVATE_KEY;
	if (key) {
		const wallet = new ethers.Wallet(key, ethers.provider);
		if (wallet.address !== ethers.getAddress(treasury)) throw new Error('TREASURY_PRIVATE_KEY does not belong to the deployment treasury');
		return wallet;
	}
	const match = (await ethers.getSigners()).find((s) => s.address === ethers.getAddress(treasury));
	if (!match) throw new Error('the treasury is not one of this network\'s accounts: set TREASURY_PRIVATE_KEY, or sign the Safe batch instead');
	return match;
}

async function execute(treasury: string, calls: Call[]): Promise<void> {
	const signer = await treasurySigner(treasury);
	for (const c of calls) {
		const receipt = await (await signer.sendTransaction({ to: c.to, data: c.data })).wait();
		console.log(`sent ${c.signature}: status ${receipt?.status} (tx ${receipt?.hash})`);
		if (receipt?.status !== 1) throw new Error(`${c.signature} failed`);
	}
}

async function main(): Promise<void> {
	if (!process.env.ROUND || !process.env.WINNERS) throw new Error('set ROUND=<id> and WINNERS=<path to winners json>');
	const roundId = BigInt(process.env.ROUND);
	const d = loadDeployment(network.name);
	const { chainId } = await ethers.provider.getNetwork();
	if (Number(chainId) !== d.chainId) throw new Error(`connected to chain ${chainId}, deployment is for ${d.chainId}`);

	const winners = JSON.parse(readFileSync(process.env.WINNERS, 'utf8')) as Winner[];
	const { leaves, totals } = buildLeaves(roundId, winners, d.stocks.map((s) => s.address));
	if (leaves.length === 0) throw new Error('no winner has a non-zero prize');
	const tree = StandardMerkleTree.of(leaves, LEAF_TYPES);
	const tokens = [...totals.keys()];
	const amounts = tokens.map((t) => totals.get(t)!);

	const erc20 = new ethers.Interface(['function approve(address spender, uint256 value) returns (bool)']);
	const prizePool = await ethers.getContractAt('PrizePool', d.prizePool);
	const calls: Call[] = [
		...tokens.map((t, i) => ({ to: t, data: erc20.encodeFunctionData('approve', [d.prizePool, amounts[i]]), signature: 'approve(address,uint256)' })),
		{
			to: d.prizePool,
			data: prizePool.interface.encodeFunctionData('postRound', [roundId, tree.root, tokens, amounts]),
			signature: 'postRound(uint256,bytes32,address[],uint256[])',
		},
	];
	calls.forEach(checkSelector);
	await simulate(d.treasury, calls);

	mkdirSync(OUT, { recursive: true });
	const claims: Record<string, { tokens: string[]; amounts: string[]; proof: string[] }> = {};
	for (const [i, [, account, leafTokens, leafAmounts]] of tree.entries()) {
		claims[account] = { tokens: leafTokens, amounts: leafAmounts.map(String), proof: tree.getProof(i) };
	}
	writeFileSync(path.join(OUT, `round-${roundId}.json`), JSON.stringify({ roundId: String(roundId), root: tree.root, claims, tree: tree.dump() }, (_k, v) => (typeof v === 'bigint' ? String(v) : v), '\t'));
	const batch = {
		version: '1.0',
		chainId: String(d.chainId),
		createdAt: Date.now(),
		meta: { name: `PrizePool round ${roundId}`, description: `Approve ${tokens.length} stock token(s) and post round ${roundId}`, createdFromSafeAddress: d.treasury },
		transactions: calls.map((c) => ({ to: c.to, value: '0', data: c.data })),
	};
	writeFileSync(path.join(OUT, `round-${roundId}-safe-batch.json`), JSON.stringify(batch, null, '\t'));
	console.log(`root ${tree.root}; wrote out/round-${roundId}.json and out/round-${roundId}-safe-batch.json`);
	if (process.env.EXECUTE === '1') await execute(d.treasury, calls);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});

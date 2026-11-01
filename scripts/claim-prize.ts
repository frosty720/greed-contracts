import { readFileSync } from 'fs';
import path from 'path';
import { ethers, network } from 'hardhat';
import { loadDeployment } from './lib/sepolia';

/** Claims a test winner's prizes for one round and checks every balance moved by exactly the leaf's amount. */

type RoundFile = { claims: Record<string, { tokens: string[]; amounts: string[]; proof: string[] }> };

async function main(): Promise<void> {
	if (!process.env.ROUND) throw new Error('set ROUND=<id>');
	const roundId = BigInt(process.env.ROUND);
	const d = loadDeployment(network.name);
	const { chainId } = await ethers.provider.getNetwork();
	if (Number(chainId) !== d.chainId) throw new Error(`connected to chain ${chainId}, deployment is for ${d.chainId}`);
	const key = process.env.TESTER_PRIVATE_KEY;
	const local = network.name === 'localhost' || network.name === 'hardhat';
	if (!key && !local) throw new Error('set TESTER_PRIVATE_KEY to the test winner wallet');
	const tester = key ? new ethers.Wallet(key, ethers.provider) : (await ethers.getSigners())[2];

	const round = JSON.parse(readFileSync(path.join(__dirname, '..', 'out', `round-${roundId}.json`), 'utf8')) as RoundFile;
	const claim = round.claims[ethers.getAddress(tester.address)];
	if (!claim) throw new Error(`${tester.address} has no prize in round ${roundId}`);

	const stocks = await Promise.all(claim.tokens.map((t) => ethers.getContractAt('MockStock', t)));
	const before = await Promise.all(stocks.map((s) => s.balanceOf(tester.address)));
	const prizePool = await ethers.getContractAt('PrizePool', d.prizePool);
	const receipt = await (await prizePool.connect(tester).claim(roundId, claim.tokens, claim.amounts, claim.proof)).wait();
	console.log(`claimed round ${roundId} as ${tester.address} (tx ${receipt!.hash})`);
	for (const [i, s] of stocks.entries()) {
		const gained = (await s.balanceOf(tester.address)) - before[i];
		console.log(`${await s.symbol()}: +${gained} (expected ${claim.amounts[i]})`);
		if (gained !== BigInt(claim.amounts[i])) throw new Error('balance moved by the wrong amount');
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});

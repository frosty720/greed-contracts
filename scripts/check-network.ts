import { ethers } from 'hardhat';

/** Pre-flight before a deploy: the chain, and each configured wallet's address and ETH balance. Never prints a key. */
async function main(): Promise<void> {
	const { chainId } = await ethers.provider.getNetwork();
	console.log(`chain ${chainId}, block ${await ethers.provider.getBlockNumber()}`);
	const wallets: [string, string | undefined][] = [
		['deployer', (await ethers.getSigners())[0]?.address],
		['tester', process.env.TESTER_PRIVATE_KEY ? new ethers.Wallet(process.env.TESTER_PRIVATE_KEY).address : undefined],
		['treasury', process.env.TREASURY_ADDRESS ? ethers.getAddress(process.env.TREASURY_ADDRESS) : undefined],
	];
	for (const [name, address] of wallets) {
		console.log(address ? `${name} ${address}: ${ethers.formatEther(await ethers.provider.getBalance(address))} ETH` : `${name}: not set`);
	}
	if (process.env.TREASURY_PRIVATE_KEY && process.env.TREASURY_ADDRESS) {
		const matches = new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY).address === ethers.getAddress(process.env.TREASURY_ADDRESS);
		console.log(`TREASURY_PRIVATE_KEY matches TREASURY_ADDRESS: ${matches}`);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});

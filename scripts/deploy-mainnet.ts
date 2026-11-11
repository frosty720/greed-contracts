import { ethers, network } from 'hardhat';
import { deployPrizePool, requireBase, requireSafe, withoutUrls } from './lib/mainnet';
import { CLAIM_WINDOW, deploymentExists, deploymentFile, loadDeployment, saveDeployment } from './lib/sepolia';

/**
 * Deploys PrizePool on Base. Without DEPLOY=1 it only runs the checks and says what it would do.
 * GreedBuyer and TokenPay aren't here: they need GREED's pool, so they deploy after its launch with deploy-mainnet-pay.ts.
 */
async function main(): Promise<void> {
	const { chainId } = await ethers.provider.getNetwork();
	requireBase(chainId);
	// The payment contracts share this file (deploy-mainnet-pay.ts), so what's already in it is kept, and only a recorded PrizePool stops this.
	const existing: Record<string, unknown> = deploymentExists(network.name) ? (loadDeployment(network.name) as unknown as Record<string, unknown>) : {};
	if (network.name === 'base' && (existing.prizePool || existing.status)) throw new Error(`${deploymentFile('base')} already records a PrizePool deploy on Base. Check its transaction, and remove that entry only if the transaction failed.`);
	const safe = process.env.BASE_TREASURY_SAFE;
	if (!safe) throw new Error('set BASE_TREASURY_SAFE to the treasury Safe on Base');
	const { threshold, owners } = await requireSafe(ethers.provider, safe);
	console.log(`treasury Safe ${safe}: ${threshold} of ${owners.length} owners`);
	const [deployer] = await ethers.getSigners();
	if (!deployer) throw new Error('set BASE_DEPLOYER_PRIVATE_KEY to a funded wallet');
	console.log(`deployer ${deployer.address}: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
	console.log(`will deploy PrizePool owned by the Safe, claim window ${CLAIM_WINDOW} s`);
	if (process.env.DEPLOY !== '1') {
		console.log('dry run: nothing was sent. Set DEPLOY=1 to deploy.');
		return;
	}
	const deployment = await deployPrizePool(deployer, safe, (sent) => {
		// Written before waiting: if the connection drops now, this file still stops a second deploy.
		saveDeployment(network.name, { ...existing, status: 'sent', ...sent });
		console.log(`sent: transaction ${sent.txHash}, PrizePool ${sent.prizePool}`);
	});
	saveDeployment(network.name, { ...existing, ...deployment });
	console.log(`PrizePool ${deployment.prizePool} in block ${deployment.block}, saved to ${deploymentFile(network.name)}`);
}

main().catch((error: unknown) => {
	console.error(withoutUrls(error instanceof Error ? error.message : String(error)));
	process.exitCode = 1;
});

import { ethers, network } from 'hardhat';
import { deployPrizePool, requireBase, requireSafe, withoutUrls } from './lib/mainnet';
import { CLAIM_WINDOW, deploymentExists, deploymentFile, saveDeployment } from './lib/sepolia';

/**
 * Deploys PrizePool on Base. Without DEPLOY=1 it only runs the checks and says what it would do.
 * GreedBuyer and TokenPay aren't here: they need GREED's pool, and a route through whichever token it is paired with.
 */
async function main(): Promise<void> {
	const { chainId } = await ethers.provider.getNetwork();
	requireBase(chainId);
	if (network.name === 'base' && deploymentExists('base')) throw new Error(`${deploymentFile('base')} exists: a PrizePool deploy was already sent on Base. Check its transaction, and remove the file only if that transaction failed.`);
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
		saveDeployment(network.name, { status: 'sent', ...sent });
		console.log(`sent: transaction ${sent.txHash}, PrizePool ${sent.prizePool}`);
	});
	saveDeployment(network.name, deployment);
	console.log(`PrizePool ${deployment.prizePool} in block ${deployment.block}, saved to ${deploymentFile(network.name)}`);
}

main().catch((error: unknown) => {
	console.error(withoutUrls(error instanceof Error ? error.message : String(error)));
	process.exitCode = 1;
});

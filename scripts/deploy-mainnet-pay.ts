import { ethers, network } from 'hardhat';
import { requireBase, requireSafe, withoutUrls } from './lib/mainnet';
import { deployPayContracts, payRoutes, requireBought, requireGreedPool, simulateRoute } from './lib/mainnet-route';
import { deploymentExists, deploymentFile, loadDeployment, saveDeployment } from './lib/sepolia';

/**
 * Deploys GreedBuyer and TokenPay on Base, on GREED's route through GOOGLc. Run it after GREED has launched: it needs
 * GREED_ADDRESS and GREED_POOL, with BASE_TREASURY_SAFE and BASE_COSTS_ADDRESS. Without DEPLOY=1 it only runs the checks,
 * including a simulation of both contracts on live state, and says what it would do. Neither contract can be changed
 * once deployed.
 * Run: npx hardhat run scripts/deploy-mainnet-pay.ts --network base
 */
async function main(): Promise<void> {
	const { chainId } = await ethers.provider.getNetwork();
	requireBase(chainId);
	const existing: Record<string, unknown> = deploymentExists(network.name) ? (loadDeployment(network.name) as unknown as Record<string, unknown>) : {};
	if (existing.buyer || existing.payStatus) throw new Error(`${deploymentFile(network.name)} already records the payment contracts. Check their transactions, and remove those entries only if they failed.`);

	const need = (name: string): string => {
		const value = process.env[name];
		if (!value) throw new Error(`set ${name}`);
		return value;
	};
	const safe = need('BASE_TREASURY_SAFE');
	const costs = need('BASE_COSTS_ADDRESS');
	const greed = need('GREED_ADDRESS');
	const greedPool = need('GREED_POOL');
	const { threshold, owners } = await requireSafe(ethers.provider, safe);
	console.log(`treasury Safe ${safe}: ${threshold} of ${owners.length} owners`);
	const { liquidity } = await requireGreedPool(ethers.provider, greedPool, greed);
	console.log(`GREED ${greed}, pool ${greedPool}, liquidity ${liquidity}`);
	const routes = payRoutes({ greed, greedPool, treasury: safe, costs });

	// The same contracts, run by the live node against the real pools, before anything permanent is sent.
	requireBought('TokenPay', await simulateRoute(ethers.provider, 'TokenPay', routes.tokenPay, [1_000_000n, 5_000_000n]));
	requireBought('GreedBuyer', await simulateRoute(ethers.provider, 'GreedBuyer', routes.buyer, [5n * 10n ** 14n, 2n * 10n ** 15n]));
	console.log('simulated both contracts on live state: payments in USDC and ETH buy GREED and pay the Safe and the costs wallet');

	const [deployer] = await ethers.getSigners();
	if (!deployer) throw new Error('set BASE_DEPLOYER_PRIVATE_KEY to a funded wallet');
	console.log(`deployer ${deployer.address}: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
	console.log(`will deploy GreedBuyer and TokenPay: treasury ${safe}, costs ${costs}, ${routes.buyer.costsBps / 100}% costs, ${routes.buyer.potsBps / 100}% pots`);
	if (process.env.DEPLOY !== '1') {
		console.log('dry run: nothing was sent. Set DEPLOY=1 to deploy.');
		return;
	}
	const sent: Record<string, { txHash: string; address: string }> = {};
	const deployment = await deployPayContracts(deployer, routes, (broadcast) => {
		// Written before waiting: if the connection drops now, the file still stops a second deploy.
		sent[broadcast.contract] = { txHash: broadcast.txHash, address: broadcast.address };
		saveDeployment(network.name, { ...existing, payStatus: 'sent', paySent: sent });
		console.log(`sent: ${broadcast.contract} ${broadcast.address}, transaction ${broadcast.txHash}`);
	});
	saveDeployment(network.name, {
		...existing,
		chainId: Number(chainId),
		greed,
		buyer: deployment.buyer,
		tokenPay: { usdc: routes.tokenPay.payToken, tokenPay: deployment.tokenPay },
		route: { stock: routes.buyer.stock, wethUsdcPool: routes.buyer.firstPool, usdcStockPool: routes.buyer.secondPool, stockGreedPool: greedPool },
		costs,
		payBlock: deployment.block,
	});
	console.log(`GreedBuyer ${deployment.buyer}, TokenPay ${deployment.tokenPay}, saved to ${deploymentFile(network.name)}`);
}

main().catch((error: unknown) => {
	console.error(withoutUrls(error instanceof Error ? error.message : String(error)));
	process.exitCode = 1;
});

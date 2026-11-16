import { ethers, network, run } from 'hardhat';
import { requireBase, withoutUrls } from './lib/mainnet';
import { Route, payRoutes } from './lib/mainnet-route';
import { loadDeployment } from './lib/sepolia';

interface BaseDeployment {
	greed: string;
	buyer: string;
	tokenPay: { tokenPay: string };
	route: { stockGreedPool: string };
	costs: string;
	treasury: string;
	prizePool: string;
	claimWindow: number;
}

const ROUTE_GETTERS = ['payToken', 'firstPool', 'secondPool', 'stock', 'stockPool', 'greed', 'treasury', 'costs', 'costsBps', 'potsBps'] as const;

/** The route a deployed GreedBuyer or TokenPay was built with must be the one rebuilt here, or verification would fail on the arguments. */
async function requireSameRoute(name: string, address: string, route: Route): Promise<void> {
	const contract = new ethers.Contract(address, ROUTE_GETTERS.map((key) => `function ${key}() view returns (${key.endsWith('Bps') ? 'uint256' : 'address'})`), ethers.provider);
	for (const key of ROUTE_GETTERS) {
		const onChain = String(await contract[key]()).toLowerCase();
		if (onChain !== String(route[key]).toLowerCase()) throw new Error(`${name} at ${address}: ${key} is ${onChain} on chain, not ${route[key]}`);
	}
}

/** Already-verified contracts are reported and skipped by the plugin, so a rerun is harmless. */
async function verify(name: string, address: string, constructorArguments: unknown[]): Promise<void> {
	console.log(`\n${name} ${address}`);
	await run('verify:verify', { address, constructorArguments });
}

/**
 * Publishes the source of GreedBuyer, TokenPay and PrizePool on BaseScan (with ETHERSCAN_API_KEY) and Sourcify, using the
 * constructor arguments rebuilt from deployments/base.json and checked against the contracts first. Sends no transactions.
 * Run: npx hardhat run scripts/verify-mainnet.ts --network base
 */
async function main(): Promise<void> {
	const { chainId } = await ethers.provider.getNetwork();
	requireBase(chainId);
	const d = loadDeployment(network.name) as unknown as BaseDeployment;
	const routes = payRoutes({ greed: d.greed, greedPool: d.route.stockGreedPool, treasury: d.treasury, costs: d.costs });
	await requireSameRoute('GreedBuyer', d.buyer, routes.buyer);
	await requireSameRoute('TokenPay', d.tokenPay.tokenPay, routes.tokenPay);
	await verify('GreedBuyer', d.buyer, [routes.buyer]);
	await verify('TokenPay', d.tokenPay.tokenPay, [routes.tokenPay]);
	await verify('PrizePool', d.prizePool, [d.treasury, d.claimWindow]);
}

main().catch((error: unknown) => {
	console.error(withoutUrls(error instanceof Error ? error.message : String(error)));
	process.exitCode = 1;
});

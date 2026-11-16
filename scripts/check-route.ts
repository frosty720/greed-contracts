import { ethers } from 'hardhat';
import { requireBase, withoutUrls } from './lib/mainnet';
import { BASE_ROUTE, SimulatedSize, payRoutes, requireBought, requireGreedPool, simulateRoute, slippagePercent } from './lib/mainnet-route';

/** GREED as launched on Stonks Exchange on 2026-11-16, and its pool against GMEc: used when GREED_ADDRESS and GREED_POOL are unset. */
const LAUNCHED = { greed: '0xcbbaf485817b174a01e29b012e6e85435765d0a7', greedPool: '0x6E9D3D023333F713671aDEF499Aa3c9f7c0B227d' };
const USDC_SIZES = [1n, 5n, 100n].map((d) => d * 10n ** 6n);
const ETH_SIZES = [5n * 10n ** 14n, 2n * 10n ** 15n, 5n * 10n ** 16n];

function table(label: string, decimalsIn: number, sizes: SimulatedSize[], decimalsOut: number): void {
	console.log(`\n${label}`);
	for (const s of sizes) {
		const out = (v: bigint | null) => (v === null ? 'not run' : ethers.formatUnits(v, decimalsOut));
		console.log(`  ${ethers.formatUnits(s.amountIn, decimalsIn)} in | payment buys ${out(s.quotePay)} | shop buy gets ${out(s.quoteBuy)} | pay, tokens moving: ${out(s.pay)} | buy, tokens moving: ${out(s.buy)}`);
	}
	console.log(`  the largest size gets ${slippagePercent(sizes).toFixed(2)}% less per unit than the smallest`);
}

/**
 * Checks GREED's payment route on Base by simulating both contracts on live state. Nothing is deployed or sent.
 * It checks GREED_ADDRESS and GREED_POOL when set, and the launched GREED and its pool when not.
 * Run: npx hardhat run scripts/check-route.ts --network base
 */
async function main(): Promise<void> {
	const { chainId } = await ethers.provider.getNetwork();
	requireBase(chainId);
	const greed = process.env.GREED_ADDRESS || LAUNCHED.greed;
	const greedPool = process.env.GREED_POOL || LAUNCHED.greedPool;
	console.log(`block ${await ethers.provider.getBlockNumber()}`);
	const { liquidity } = await requireGreedPool(ethers.provider, greedPool, greed);
	console.log(`GREED ${greed}, pool ${greedPool} on the launchpad's factory, liquidity ${liquidity}`);
	// Any plain addresses receive the simulated split; the real ones matter only at deploy.
	const treasury = process.env.BASE_TREASURY_SAFE ?? ethers.Wallet.createRandom().address;
	const costs = process.env.BASE_COSTS_ADDRESS ?? ethers.Wallet.createRandom().address;
	const routes = payRoutes({ greed, greedPool, treasury, costs });
	const decimals = Number(await new ethers.Contract(greed, ['function decimals() view returns (uint8)'], ethers.provider).decimals());

	const usdc = await simulateRoute(ethers.provider, 'TokenPay', routes.tokenPay, USDC_SIZES, BASE_ROUTE.wethUsdcPool);
	requireBought('TokenPay', usdc);
	table(`USDC -> GMEc (${BASE_ROUTE.gmeUsdcPool}) -> GREED`, 6, usdc, decimals);
	const eth = await simulateRoute(ethers.provider, 'GreedBuyer', routes.buyer, ETH_SIZES);
	requireBought('GreedBuyer', eth);
	table(`ETH -> USDC (${BASE_ROUTE.wethUsdcPool}) -> GMEc -> GREED`, 18, eth, decimals);
	console.log('\nthe route works');
}

main().catch((error: unknown) => {
	console.error(withoutUrls(error instanceof Error ? error.message : String(error)));
	process.exitCode = 1;
});

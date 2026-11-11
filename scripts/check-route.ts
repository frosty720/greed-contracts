import { ethers } from 'hardhat';
import { requireBase, withoutUrls } from './lib/mainnet';
import { BASE_ROUTE, SimulatedSize, payRoutes, requireBought, requireGreedPool, simulateRoute, slippagePercent } from './lib/mainnet-route';

/**
 * A stand-in for GREED until it launches: a live Aerodrome pool of frxUSD against GOOGLc. It proves the legs up to the
 * stock and that the stock really moves; GREED's own pool can only be checked once it exists.
 */
const STAND_IN = { greed: '0xe5020A6d073a794B6E7f05678707dE47986Fb0b6', greedPool: '0x5e7Fe8ADAEFAb50B51D806767F33b1D15cCf4201', symbol: 'frxUSD (stand-in)' };
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
 * With GREED_ADDRESS and GREED_POOL it checks the real route; without them, a stand-in for GREED.
 * Run: npx hardhat run scripts/check-route.ts --network base
 */
async function main(): Promise<void> {
	const { chainId } = await ethers.provider.getNetwork();
	requireBase(chainId);
	const real = Boolean(process.env.GREED_ADDRESS && process.env.GREED_POOL);
	const greed = process.env.GREED_ADDRESS ?? STAND_IN.greed;
	const greedPool = process.env.GREED_POOL ?? STAND_IN.greedPool;
	console.log(`block ${await ethers.provider.getBlockNumber()}`);
	if (real) {
		const { liquidity } = await requireGreedPool(ethers.provider, greedPool, greed);
		console.log(`GREED ${greed}, pool ${greedPool} on the launchpad's factory, liquidity ${liquidity}`);
	} else {
		console.log(`GREED_ADDRESS and GREED_POOL are not set: using ${STAND_IN.symbol} in place of GREED`);
	}
	// Any plain addresses receive the simulated split; the real ones matter only at deploy.
	const treasury = process.env.BASE_TREASURY_SAFE ?? ethers.Wallet.createRandom().address;
	const costs = process.env.BASE_COSTS_ADDRESS ?? ethers.Wallet.createRandom().address;
	const routes = payRoutes({ greed, greedPool, treasury, costs });
	const decimals = Number(await new ethers.Contract(greed, ['function decimals() view returns (uint8)'], ethers.provider).decimals());

	const usdc = await simulateRoute(ethers.provider, 'TokenPay', routes.tokenPay, USDC_SIZES, BASE_ROUTE.wethUsdcPool);
	requireBought('TokenPay', usdc);
	table(`USDC -> GOOGLc (${BASE_ROUTE.googlUsdcPool}) -> GREED`, 6, usdc, decimals);
	const eth = await simulateRoute(ethers.provider, 'GreedBuyer', routes.buyer, ETH_SIZES);
	requireBought('GreedBuyer', eth);
	table(`ETH -> USDC (${BASE_ROUTE.wethUsdcPool}) -> GOOGLc -> GREED`, 18, eth, decimals);
	console.log(`\nthe route works${real ? '' : ' up to the stand-in; run again with GREED_ADDRESS and GREED_POOL once GREED has launched'}`);
}

main().catch((error: unknown) => {
	console.error(withoutUrls(error instanceof Error ? error.message : String(error)));
	process.exitCode = 1;
});

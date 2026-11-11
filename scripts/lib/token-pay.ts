import { Signer } from 'ethers';
import { ethers } from 'hardhat';
import { oneWayPoolPrice, priceToSqrtPriceX96, singleSidedRange, usdPerGreedFromEthPool } from './pool-math';
import { Deployment, FACTORY_ABI, POOL_ABI, POSITION_MANAGER_ABI, RouteDeployment, SEPOLIA } from './sepolia';

const ETH_USD = 2_250; // near Chainlink's Base Sepolia answer; a mock pool's price doesn't need to be exact
const STOCK_USD = 100; // what one mock share costs in test USDC
const POOL_USDC = 10_000n * 10n ** 6n; // MockUSDC's largest single mint
const POOL_STOCK = 10_000n * 10n ** 8n;
const POOL_GREED = 20_000_000n * 10n ** 18n; // leaves the deployer enough tGREED to run this twice

/** Where payments send the treasury's share: PAY_TREASURY, or the deployment's treasury if it is unset. */
export function payTreasury(d: Deployment): string {
	const treasury = process.env.PAY_TREASURY ?? d.treasury;
	if (!ethers.isAddress(treasury)) throw new Error('PAY_TREASURY must be an address');
	return treasury;
}

/** Each payment's split, in bps of the payment. Whatever is left buys GREED. Must match the backend's PAYMENTS.potsBps. */
export const SPLIT = { costsBps: 1000, potsBps: 5000 };

interface OneWayPool {
	tokenOut: string;
	decimalsOut: number;
	tokenIn: string;
	decimalsIn: number;
	priceOfOutInIn: number;
	amountOut: bigint;
}

/** A pool holding only the token it sells, so a test payment can swap into it without anyone seeding the other side. A pool that already exists is topped up, so a failed run can be finished. */
async function deployOneWayPool(deployer: Signer, p: OneWayPool): Promise<string> {
	const factory = new ethers.Contract(SEPOLIA.uniswapFactory, FACTORY_ABI, deployer);
	let poolAddr: string = await factory.getPool(p.tokenOut, p.tokenIn, SEPOLIA.poolFee);
	if (poolAddr === ethers.ZeroAddress) {
		await (await factory.createPool(p.tokenOut, p.tokenIn, SEPOLIA.poolFee)).wait();
		poolAddr = await factory.getPool(p.tokenOut, p.tokenIn, SEPOLIA.poolFee);
	}
	const pool = new ethers.Contract(poolAddr, POOL_ABI, deployer);
	const outIsToken0 = p.tokenOut.toLowerCase() < p.tokenIn.toLowerCase();
	const [sqrtPriceX96] = (await pool.slot0()) as [bigint];
	if (sqrtPriceX96 === 0n) await (await pool.initialize(priceToSqrtPriceX96(oneWayPoolPrice(p.priceOfOutInIn, p.decimalsOut, p.decimalsIn, outIsToken0)))).wait();
	const [, tick] = (await pool.slot0()) as [bigint, bigint];
	const { tickLower, tickUpper } = singleSidedRange(Number(tick), outIsToken0, SEPOLIA.tickSpacing);

	const token = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', p.tokenOut, deployer);
	await (await token.approve(SEPOLIA.positionManager, p.amountOut)).wait();
	const manager = new ethers.Contract(SEPOLIA.positionManager, POSITION_MANAGER_ABI, deployer);
	await (
		await manager.mint({
			token0: outIsToken0 ? p.tokenOut : p.tokenIn,
			token1: outIsToken0 ? p.tokenIn : p.tokenOut,
			fee: SEPOLIA.poolFee,
			tickLower,
			tickUpper,
			amount0Desired: outIsToken0 ? p.amountOut : 0n,
			amount1Desired: outIsToken0 ? 0n : p.amountOut,
			amount0Min: 0n,
			amount1Min: 0n,
			recipient: await deployer.getAddress(),
			deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
		})
	).wait();
	return poolAddr;
}

/** A test USDC, for a deployment that doesn't have one yet. */
export async function deployMockUsdc(deployer: Signer): Promise<string> {
	const usdc = await (await ethers.deployContract('MockUSDC', [], deployer)).waitForDeployment();
	return usdc.getAddress();
}

/** The mock market a payment walks: WETH to test USDC, test USDC to the mock stock GREED is paired with, the stock to tGREED. */
export async function deployRoutePools(deployer: Signer, d: Deployment, usdc: string, log: (line: string) => void = () => undefined): Promise<RouteDeployment> {
	const stockInfo = d.stocks[0];
	const owner = await deployer.getAddress();
	await (await (await ethers.getContractAt('MockUSDC', usdc, deployer)).mint(owner, POOL_USDC)).wait();
	await (await (await ethers.getContractAt('MockStock', stockInfo.address, deployer)).mint(owner, POOL_STOCK)).wait();

	const ethPool = new ethers.Contract(d.pool, POOL_ABI, deployer);
	const [ethPoolSqrtPrice] = (await ethPool.slot0()) as [bigint];
	const usdPerGreed = usdPerGreedFromEthPool(ethPoolSqrtPrice, d.greed.toLowerCase() < d.weth.toLowerCase(), ETH_USD);

	const wethUsdcPool = await deployOneWayPool(deployer, { tokenOut: usdc, decimalsOut: 6, tokenIn: d.weth, decimalsIn: 18, priceOfOutInIn: 1 / ETH_USD, amountOut: POOL_USDC });
	log(`WETH/tUSDC pool ${wethUsdcPool}`);
	const usdcStockPool = await deployOneWayPool(deployer, { tokenOut: stockInfo.address, decimalsOut: stockInfo.decimals, tokenIn: usdc, decimalsIn: 6, priceOfOutInIn: STOCK_USD, amountOut: POOL_STOCK });
	log(`tUSDC/${stockInfo.symbol} pool ${usdcStockPool}`);
	const stockGreedPool = await deployOneWayPool(deployer, { tokenOut: d.greed, decimalsOut: 18, tokenIn: stockInfo.address, decimalsIn: stockInfo.decimals, priceOfOutInIn: usdPerGreed / STOCK_USD, amountOut: POOL_GREED });
	log(`${stockInfo.symbol}/tGREED pool ${stockGreedPool}, 1 tGREED = $${usdPerGreed}`);
	return { stock: stockInfo.address, wethUsdcPool, usdcStockPool, stockGreedPool };
}

/**
 * GreedBuyer and TokenPay on the route, paying `treasury`: the wallet whose incoming stock the backend counts into the pots
 * (its COIN_TREASURY). Neither can change once deployed, so a new version is a new pair of contracts.
 */
export async function deployPayContracts(deployer: Signer, d: Deployment, usdc: string, route: RouteDeployment, treasury: string, costs: string): Promise<{ buyer: string; tokenPay: string }> {
	const shared = { stock: route.stock, stockPool: route.stockGreedPool, greed: d.greed, treasury, costs, ...SPLIT };
	const buyer = await (await ethers.deployContract('GreedBuyer', [{ ...shared, payToken: d.weth, firstPool: route.wethUsdcPool, secondPool: route.usdcStockPool }], deployer)).waitForDeployment();
	const tokenPay = await (await ethers.deployContract('TokenPay', [{ ...shared, payToken: usdc, firstPool: route.usdcStockPool, secondPool: ethers.ZeroAddress }], deployer)).waitForDeployment();
	return { buyer: await buyer.getAddress(), tokenPay: await tokenPay.getAddress() };
}

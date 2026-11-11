import { ethers, network } from 'hardhat';
import { priceToSqrtPriceX96, singleSidedRange } from './lib/pool-math';
import {
	CLAIM_WINDOW,
	FACTORY_ABI,
	POOL_ABI,
	POSITION_MANAGER_ABI,
	SEPOLIA,
	StockInfo,
	deploymentExists,
	deploymentFile,
	saveDeployment,
} from './lib/sepolia';

const LAUNCH_MCAP_USD = 4_000; // a Stonks launch opens at a $4K market cap
const ETH_USD = 2_300;
const SUPPLY = 1_000_000_000;
const POOL_GREED = 900_000_000n * 10n ** 18n; // the deployer keeps 100M tGREED for test wallets
const STOCK_SEED = 1_000n * 10n ** 8n; // per mock stock, standing in for a Stockify harvest
const STOCKS: { name: string; symbol: string }[] = [
	{ name: 'Mock Stock Alpha', symbol: 'MSKA' },
	{ name: 'Mock Stock Beta', symbol: 'MSKB' },
	{ name: 'Mock Stock Gamma', symbol: 'MSKC' },
];

async function main(): Promise<void> {
	const { chainId } = await ethers.provider.getNetwork();
	if (chainId !== SEPOLIA.chainId) throw new Error(`refusing to deploy: chain ${chainId} is not Base Sepolia (84532)`);
	const treasury = process.env.TREASURY_ADDRESS;
	if (!treasury || !ethers.isAddress(treasury)) throw new Error('set TREASURY_ADDRESS to the treasury wallet on Base Sepolia (a plain wallet on testnet, the Safe on mainnet)');
	if (deploymentExists(network.name) && process.env.FORCE !== '1') throw new Error(`${deploymentFile(network.name)} exists; set FORCE=1 to deploy again`);
	const [deployer] = await ethers.getSigners();
	console.log(`deployer ${deployer.address} on ${network.name}, treasury ${treasury}`);

	const greed = await (await ethers.deployContract('MockGreed')).waitForDeployment();
	const greedAddr = await greed.getAddress();
	console.log(`MockGreed ${greedAddr}`);

	const stocks: StockInfo[] = [];
	for (const s of STOCKS) {
		const stock = await (await ethers.deployContract('MockStock', [s.name, s.symbol, deployer.address])).waitForDeployment();
		const address = await stock.getAddress();
		await (await stock.mint(treasury, STOCK_SEED)).wait();
		stocks.push({ address, name: s.name, symbol: s.symbol, decimals: 8 });
		console.log(`MockStock ${s.symbol} ${address} (1,000 minted to the treasury)`);
	}

	const factory = new ethers.Contract(SEPOLIA.uniswapFactory, FACTORY_ABI, deployer);
	await (await factory.createPool(greedAddr, SEPOLIA.weth, SEPOLIA.poolFee)).wait();
	const poolAddr: string = await factory.getPool(greedAddr, SEPOLIA.weth, SEPOLIA.poolFee);
	const pool = new ethers.Contract(poolAddr, POOL_ABI, deployer);
	const greedIsToken0 = greedAddr.toLowerCase() < SEPOLIA.weth.toLowerCase();
	const wethPerGreed = LAUNCH_MCAP_USD / ETH_USD / SUPPLY;
	await (await pool.initialize(priceToSqrtPriceX96(greedIsToken0 ? wethPerGreed : 1 / wethPerGreed))).wait();
	const [, tick] = (await pool.slot0()) as [bigint, bigint];
	const { tickLower, tickUpper } = singleSidedRange(Number(tick), greedIsToken0, SEPOLIA.tickSpacing);
	console.log(`pool ${poolAddr} at tick ${tick}, GREED is token${greedIsToken0 ? 0 : 1}, range [${tickLower}, ${tickUpper}]`);

	await (await greed.approve(SEPOLIA.positionManager, POOL_GREED)).wait();
	const manager = new ethers.Contract(SEPOLIA.positionManager, POSITION_MANAGER_ABI, deployer);
	const mintTx = await manager.mint({
		token0: greedIsToken0 ? greedAddr : SEPOLIA.weth,
		token1: greedIsToken0 ? SEPOLIA.weth : greedAddr,
		fee: SEPOLIA.poolFee,
		tickLower,
		tickUpper,
		amount0Desired: greedIsToken0 ? POOL_GREED : 0n,
		amount1Desired: greedIsToken0 ? 0n : POOL_GREED,
		amount0Min: 0n,
		amount1Min: 0n,
		recipient: deployer.address,
		deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
	});
	const mintReceipt = await mintTx.wait();
	const increased = mintReceipt.logs
		.map((log: { topics: string[]; data: string }) => manager.interface.parseLog(log))
		.find((parsed: { name: string } | null) => parsed?.name === 'IncreaseLiquidity');
	if (!increased) throw new Error('position mint emitted no IncreaseLiquidity');
	const positionTokenId = String(increased.args.tokenId);
	// The pool's active liquidity reads 0 until the first buy: a single-sided position sits just past the price.
	console.log(`position #${positionTokenId}, liquidity ${increased.args.liquidity}, pool holds ${ethers.formatEther(await greed.balanceOf(poolAddr))} tGREED`);

	const prizePool = await (await ethers.deployContract('PrizePool', [treasury, CLAIM_WINDOW])).waitForDeployment();
	console.log(`PrizePool ${await prizePool.getAddress()}`);

	saveDeployment(network.name, {
		chainId: Number(chainId),
		block: mintReceipt.blockNumber,
		weth: SEPOLIA.weth,
		greed: greedAddr,
		pool: poolAddr,
		poolFee: SEPOLIA.poolFee,
		positionTokenId,
		buyer: ethers.ZeroAddress, // GreedBuyer needs the route, so deploy-token-pay.ts deploys it
		prizePool: await prizePool.getAddress(),
		treasury,
		claimWindow: CLAIM_WINDOW,
		stocks,
	});
	console.log(`wrote ${deploymentFile(network.name)}`);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});

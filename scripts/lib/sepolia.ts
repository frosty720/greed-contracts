import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';

/** Base Sepolia (84532) contracts, each checked on-chain with cast on 2026-10-26. */
export const SEPOLIA = {
	chainId: 84532n,
	weth: '0x4200000000000000000000000000000000000006',
	uniswapFactory: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
	positionManager: '0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2',
	poolFee: 10000,
	tickSpacing: 200,
} as const;

export const CLAIM_WINDOW = 2_419_200; // 28 days

export const FACTORY_ABI = [
	'function createPool(address tokenA, address tokenB, uint24 fee) returns (address pool)',
	'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
];
export const POOL_ABI = [
	'function initialize(uint160 sqrtPriceX96)',
	'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
	'function liquidity() view returns (uint128)',
];
export const POSITION_MANAGER_ABI = [
	'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
	'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
];

export interface StockInfo {
	address: string;
	name: string;
	symbol: string;
	decimals: number;
}

/** What pays in USDC and GREED. Added to the deployment after the first contracts. */
export interface TokenPayDeployment {
	usdc: string;
	tokenPay: string;
}

/** The mock market a payment walks: ETH to USDC, USDC to the stock GREED is paired with, the stock to GREED. */
export interface RouteDeployment {
	stock: string;
	wethUsdcPool: string;
	usdcStockPool: string;
	stockGreedPool: string;
}

/** What Phase 6b's backend reads to find the testnet contracts. */
export interface Deployment {
	chainId: number;
	block: number;
	weth: string;
	greed: string;
	pool: string;
	poolFee: number;
	positionTokenId: string;
	buyer: string;
	prizePool: string;
	treasury: string;
	claimWindow: number;
	stocks: StockInfo[];
	tokenPay?: TokenPayDeployment;
	route?: RouteDeployment;
	costs?: string;
}

const DEPLOYMENT_FILES: Record<string, string> = { base: 'base.json', baseSepolia: 'base-sepolia.json' };

/** Base and Base Sepolia write committed files; a local fork dry run writes an ignored one, so fork addresses never leak. */
export function deploymentFile(networkName: string): string {
	return path.join(__dirname, '..', '..', 'deployments', DEPLOYMENT_FILES[networkName] ?? 'local-fork.json');
}

export function loadDeployment(networkName: string): Deployment {
	return JSON.parse(readFileSync(deploymentFile(networkName), 'utf8')) as Deployment;
}

export function saveDeployment(networkName: string, d: object): void {
	const file = deploymentFile(networkName);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(d, null, '\t') + '\n');
}

export function deploymentExists(networkName: string): boolean {
	return existsSync(deploymentFile(networkName));
}

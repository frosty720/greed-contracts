import { BaseContract } from 'ethers';
import { ethers, network } from 'hardhat';
import { MockUSDC, MockWETH } from '../../typechain-types';

export const ONE_USDC = 10n ** 6n;
export const ONE_GREED = 10n ** 18n;
/** One unit in for one unit out, for pools whose price doesn't matter to the test. */
export const ONE_TO_ONE = 10n ** 18n;
/** MockSwapPool's output per input, scaled by 1e18: a dollar of stock (1e6 units) buys 250,000 GREED (18 decimals). */
export const GREED_PER_STOCK = 250_000n * 10n ** 30n;
/** 10% to costs, 50% to the pots, so 40% buys GREED. */
export const SPLIT = { costsBps: 1000, potsBps: 5000 };

/** Puts a mock's code at a chosen address, so a test can pick which side of a pool a token sorts on. */
export async function plantToken(at: string): Promise<MockUSDC>;
export async function plantToken(at: string, artifact: 'MockWETH'): Promise<MockWETH>;
export async function plantToken(at: string, artifact: 'MockUSDC' | 'MockWETH' = 'MockUSDC'): Promise<MockUSDC | MockWETH> {
	const template = await ethers.deployContract(artifact);
	await network.provider.send('hardhat_setCode', [at, await ethers.provider.getCode(await template.getAddress())]);
	return artifact === 'MockWETH' ? ethers.getContractAt('MockWETH', at) : ethers.getContractAt('MockUSDC', at);
}

/** Tokens planted at fixed addresses keep their balances, so each test in a describe runs on its own snapshot of the chain. */
export function freshChainEachTest(): void {
	let snapshot: string;
	beforeEach(async () => {
		snapshot = await network.provider.send('evm_snapshot');
	});
	afterEach(async () => {
		await network.provider.send('evm_revert', [snapshot]);
	});
}

type Funded = (poolAddress: string) => Promise<unknown>;

/** A fixed-price pool of tokenIn for tokenOut, already holding the tokenOut it will pay. */
export async function fundedPool(tokenIn: BaseContract, tokenOut: BaseContract, priceE18: bigint, fund: Funded) {
	const pool = await ethers.deployContract('MockSwapPool', [await tokenIn.getAddress(), await tokenOut.getAddress(), priceE18, 10_000]);
	await fund(await pool.getAddress());
	return pool;
}

export const minted = (token: { mint: (to: string, amount: bigint) => Promise<unknown> }): Funded => (to) => token.mint(to, 10_000n * ONE_USDC);

export const sentGreed = (greed: { transfer: (to: string, amount: bigint) => Promise<unknown> }): Funded => (to) => greed.transfer(to, 500_000_000n * ONE_GREED);

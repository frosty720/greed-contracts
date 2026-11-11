import { Contract, Provider, Signer, getAddress, isAddress } from 'ethers';
import { ethers } from 'hardhat';
import { CLAIM_WINDOW } from './sepolia';

/** Base mainnet contracts, each read on-chain with cast on 2026-11-09 (symbol or description, and decimals). */
export const BASE = {
	chainId: 8453n,
	weth: '0x4200000000000000000000000000000000000006',
	usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
	ethUsdFeed: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
} as const;

const SAFE_ABI = ['function getThreshold() view returns (uint256)', 'function getOwners() view returns (address[])'];

export interface MainnetDeployment {
	chainId: number;
	block: number;
	treasury: string;
	prizePool: string;
	claimWindow: number;
}

export interface PrizePoolBroadcast {
	txHash: string;
	prizePool: string;
}

export function requireBase(chainId: bigint): void {
	if (chainId !== BASE.chainId) throw new Error(`refusing to deploy: chain ${chainId} is not Base (8453)`);
}

/** Error messages from an RPC client can carry the endpoint, which may hold a key. */
export function withoutUrls(message: string): string {
	return message.replace(/https?:\/\/\S+/g, '<rpc-url>');
}

/** The prize pool's owner posts and funds every round, so it has to be the multisig and not a single key. */
export async function requireSafe(provider: Provider, address: string): Promise<{ threshold: bigint; owners: string[] }> {
	if (!isAddress(address)) throw new Error(`${address} is not an address`);
	if ((await provider.getCode(address)) === '0x') throw new Error(`${address} has no contract on this chain, so it can't be the treasury Safe`);
	const safe = new Contract(address, SAFE_ABI, provider);
	try {
		const threshold = (await safe.getThreshold()) as bigint;
		const owners = (await safe.getOwners()) as string[];
		return { threshold, owners: [...owners] };
	} catch (error) {
		throw new Error(`${address} is not a Safe, or the RPC failed: ${withoutUrls((error as Error).message)}`);
	}
}

/**
 * Deploys PrizePool with the Safe as owner from the first block, so the deployer never holds any power over it.
 * `onBroadcast` runs as soon as the transaction is sent, before waiting for it, so a dropped connection still leaves a record.
 */
export async function deployPrizePool(deployer: Signer, safe: string, onBroadcast: (sent: PrizePoolBroadcast) => void | Promise<void> = () => undefined): Promise<MainnetDeployment> {
	const pool = await ethers.deployContract('PrizePool', [safe, CLAIM_WINDOW], deployer);
	const tx = pool.deploymentTransaction();
	if (!tx) throw new Error('PrizePool deploy returned no transaction');
	const prizePool = await pool.getAddress();
	await onBroadcast({ txHash: tx.hash, prizePool });
	const receipt = await tx.wait();
	if (!receipt) throw new Error('PrizePool deployed but its receipt is missing');
	const { chainId } = await ethers.provider.getNetwork();
	return { chainId: Number(chainId), block: receipt.blockNumber, treasury: getAddress(safe), prizePool, claimWindow: CLAIM_WINDOW };
}

import { ethers, network } from 'hardhat';
import { deployMockUsdc, deployPayContracts, deployRoutePools, payTreasury } from './lib/token-pay';
import { SEPOLIA, loadDeployment, saveDeployment } from './lib/sepolia';

/**
 * The mock route a payment walks, and GreedBuyer and TokenPay on it. Payments pay PAY_TREASURY (set it to the backend's
 * COIN_TREASURY), and costs go to COSTS_ADDRESS; either unset means the deployment's treasury.
 */
async function main(): Promise<void> {
	const { chainId } = await ethers.provider.getNetwork();
	if (chainId !== SEPOLIA.chainId) throw new Error(`refusing to deploy: chain ${chainId} is not Base Sepolia (84532)`);
	const d = loadDeployment(network.name);
	if (d.route && process.env.FORCE !== '1') throw new Error('the route is already deployed; run redeploy-token-pay.ts for new contracts, or set FORCE=1 to top up its pools and deploy again');
	const costs = process.env.COSTS_ADDRESS ?? d.treasury;
	if (!ethers.isAddress(costs)) throw new Error('COSTS_ADDRESS must be an address');
	const [deployer] = await ethers.getSigners();
	const treasury = payTreasury(d);
	console.log(`deployer ${deployer.address} on ${network.name}, treasury ${treasury}, costs ${costs}`);
	const usdc = d.tokenPay?.usdc ?? (await deployMockUsdc(deployer));
	const route = await deployRoutePools(deployer, d, usdc, console.log);
	const { buyer, tokenPay } = await deployPayContracts(deployer, d, usdc, route, treasury, costs);
	console.log(`GreedBuyer ${buyer}`);
	console.log(`TokenPay ${tokenPay}`);
	saveDeployment(network.name, { ...d, buyer, tokenPay: { usdc, tokenPay }, route, costs });
	console.log('saved to the deployment file');
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});

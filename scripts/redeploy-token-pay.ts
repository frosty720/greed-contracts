import { ethers, network } from 'hardhat';
import { deployPayContracts, payTreasury } from './lib/token-pay';
import { SEPOLIA, loadDeployment, saveDeployment } from './lib/sepolia';

/** A new GreedBuyer and TokenPay on the route the deployment already has, paying PAY_TREASURY; the old ones are left unused. */
async function main(): Promise<void> {
	const { chainId } = await ethers.provider.getNetwork();
	if (chainId !== SEPOLIA.chainId) throw new Error(`refusing to deploy: chain ${chainId} is not Base Sepolia (84532)`);
	const d = loadDeployment(network.name);
	if (!d.tokenPay || !d.route || !d.costs) throw new Error('no route in the deployment: run deploy-token-pay.ts first');
	const [deployer] = await ethers.getSigners();
	const treasury = payTreasury(d);
	console.log(`deployer ${deployer.address} on ${network.name}, replacing GreedBuyer ${d.buyer} and TokenPay ${d.tokenPay.tokenPay}, treasury ${treasury}`);
	const { buyer, tokenPay } = await deployPayContracts(deployer, d, d.tokenPay.usdc, d.route, treasury, d.costs);
	saveDeployment(network.name, { ...d, buyer, tokenPay: { ...d.tokenPay, tokenPay } });
	console.log(`GreedBuyer ${buyer}, TokenPay ${tokenPay}, saved to the deployment file`);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});

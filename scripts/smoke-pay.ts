import { ethers, network } from 'hardhat';
import { loadDeployment } from './lib/sepolia';

const ETH_IN = 10n ** 15n; // 0.001 ETH
const SLIPPAGE_KEEP = 98n; // floor = 98% of the quote
const ERC20 = '@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20';

interface Erc20 {
	balanceOf: (holder: string) => Promise<bigint>;
}

async function main(): Promise<void> {
	const d = loadDeployment(network.name);
	const { chainId } = await ethers.provider.getNetwork();
	if (Number(chainId) !== d.chainId) throw new Error(`connected to chain ${chainId}, deployment is for ${d.chainId}`);
	if (!d.route || !d.costs) throw new Error('no route in the deployment: run deploy-token-pay.ts first');

	const buyer = await ethers.getContractAt('GreedBuyer', d.buyer);
	const quote = (await buyer.quotePay.staticCall(ETH_IN)) as bigint;
	const minGreedOut = (quote * SLIPPAGE_KEEP) / 100n;
	console.log(`quote ${ethers.formatEther(quote)} tGREED for 0.001 ETH, floor ${ethers.formatEther(minGreedOut)}`);

	const treasury = await buyer.treasury();
	const greed = await ethers.getContractAt('MockGreed', d.greed);
	const stock = (await ethers.getContractAt(ERC20, d.route.stock)) as unknown as Erc20;
	const weth = (await ethers.getContractAt(ERC20, d.weth)) as unknown as Erc20;
	const [greedBefore, stockBefore, costsBefore] = [await greed.balanceOf(treasury), await stock.balanceOf(treasury), await weth.balanceOf(d.costs)];
	const receipt = await (await buyer.pay(ethers.id('smoke-1'), minGreedOut, { value: ETH_IN })).wait();
	const paid = receipt!.logs.map((log) => buyer.interface.parseLog(log)).find((parsed) => parsed?.name === 'Paid');
	if (!paid) throw new Error('pay emitted no Paid event');
	const greedOut = paid.args.greedOut as bigint;
	const gained = (await greed.balanceOf(treasury)) - greedBefore;
	const toPots = (await stock.balanceOf(treasury)) - stockBefore;
	const toCosts = (await weth.balanceOf(d.costs)) - costsBefore;
	console.log(`Paid payer=${paid.args.payer} quoteId=${paid.args.quoteId} ethIn=${paid.args.ethIn} greedOut=${greedOut} (tx ${receipt!.hash})`);
	const buyerEth = await ethers.provider.getBalance(d.buyer);
	const buyerWeth = await weth.balanceOf(d.buyer);
	console.log(`treasury gained ${gained} tGREED and ${toPots} stock units; costs gained ${toCosts} WETH; buyer holds ${buyerEth} wei ETH and ${buyerWeth} WETH`);
	if (greedOut < minGreedOut) throw new Error('greedOut is below the slippage floor');
	if (gained !== greedOut) throw new Error('treasury balance does not match greedOut');
	if (toPots === 0n) throw new Error('nothing reached the pots');
	if (toCosts !== ETH_IN / 10n) throw new Error('costs did not get 10%');
	if (buyerEth !== 0n || buyerWeth !== 0n) throw new Error('the buyer kept funds after the swap');
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});

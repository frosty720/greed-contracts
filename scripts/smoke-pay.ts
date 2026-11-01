import { ethers, network } from 'hardhat';
import { QUOTER_ABI, SEPOLIA, loadDeployment } from './lib/sepolia';

const ETH_IN = 10n ** 15n; // 0.001 ETH
const SLIPPAGE_KEEP = 98n; // floor = 98% of the quote

async function main(): Promise<void> {
	const d = loadDeployment(network.name);
	const { chainId } = await ethers.provider.getNetwork();
	if (Number(chainId) !== d.chainId) throw new Error(`connected to chain ${chainId}, deployment is for ${d.chainId}`);

	const quoter = new ethers.Contract(SEPOLIA.quoterV2, QUOTER_ABI, ethers.provider);
	const [quote] = (await quoter.quoteExactInputSingle.staticCall({
		tokenIn: d.weth,
		tokenOut: d.greed,
		amountIn: ETH_IN,
		fee: d.poolFee,
		sqrtPriceLimitX96: 0n,
	})) as [bigint];
	const minGreedOut = (quote * SLIPPAGE_KEEP) / 100n;
	console.log(`quote ${ethers.formatEther(quote)} tGREED for 0.001 ETH, floor ${ethers.formatEther(minGreedOut)}`);

	const greed = await ethers.getContractAt('MockGreed', d.greed);
	const before = await greed.balanceOf(d.treasury);
	const buyer = await ethers.getContractAt('GreedBuyer', d.buyer);
	const receipt = await (await buyer.pay(ethers.id('smoke-1'), minGreedOut, { value: ETH_IN })).wait();
	const paid = receipt!.logs.map((log) => buyer.interface.parseLog(log)).find((parsed) => parsed?.name === 'Paid');
	if (!paid) throw new Error('pay emitted no Paid event');
	const greedOut = paid.args.greedOut as bigint;
	const gained = (await greed.balanceOf(d.treasury)) - before;
	console.log(`Paid payer=${paid.args.payer} quoteId=${paid.args.quoteId} ethIn=${paid.args.ethIn} greedOut=${greedOut} (tx ${receipt!.hash})`);
	const buyerEth = await ethers.provider.getBalance(d.buyer);
	const buyerWeth = await (await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', d.weth)).balanceOf(d.buyer);
	console.log(`treasury gained ${gained} tGREED; buyer holds ${buyerEth} wei ETH and ${buyerWeth} WETH`);
	if (greedOut < minGreedOut) throw new Error('greedOut is below the slippage floor');
	if (gained !== greedOut) throw new Error('treasury balance does not match greedOut');
	if (buyerEth !== 0n || buyerWeth !== 0n) throw new Error('the buyer kept funds after the swap');
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});

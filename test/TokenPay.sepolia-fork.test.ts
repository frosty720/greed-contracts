import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { Signer } from 'ethers';
import { readFileSync } from 'fs';
import path from 'path';
import { deployPayContracts, deployRoutePools } from '../scripts/lib/token-pay';
import { Deployment, RouteDeployment } from '../scripts/lib/sepolia';

const DEPLOYER = '0xaE51f2EfE70e57b994BE8F7f97C4dC824c51802a';
const COSTS = '0x00000000000000000000000000000000000C0575';
const ERC20 = '@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20';
const ETH_USD = 2_250n;

const suite = process.env.FORK === '1' && process.env.FORK_CHAIN_ID === '84532' ? describe : describe.skip;

// The live test tokens and Uniswap at a pinned block. The route is built on the fork with the same code deploy-token-pay.ts
// runs, then every payment goes through real Uniswap pools. Nothing here is sent to the chain.
suite('The payment split on real Uniswap (Base Sepolia fork)', function () {
	this.timeout(300_000);
	const d = JSON.parse(readFileSync(path.join(__dirname, '..', 'deployments', 'base-sepolia.json'), 'utf8')) as Deployment;
	const usdcAt = d.tokenPay!.usdc;
	let deployer: Signer;
	let route: RouteDeployment;
	let buyerAt: string;
	let payAt: string;

	before(async () => {
		await network.provider.send('hardhat_impersonateAccount', [DEPLOYER]);
		await network.provider.send('hardhat_setBalance', [DEPLOYER, '0x56BC75E2D63100000']);
		deployer = await ethers.getSigner(DEPLOYER);
		route = await deployRoutePools(deployer, d, usdcAt);
		({ buyer: buyerAt, tokenPay: payAt } = await deployPayContracts(deployer, d, usdcAt, route, d.treasury, COSTS));
	});

	const payWith = async (usdcIn: bigint) => {
		const [tester] = await ethers.getSigners();
		const usdc = await ethers.getContractAt('MockUSDC', usdcAt);
		await usdc.mint(tester.address, usdcIn);
		await usdc.connect(tester).approve(payAt, usdcIn);
		return (await ethers.getContractAt('TokenPay', payAt)).connect(tester);
	};

	const balances = async (): Promise<{ greed: bigint; stock: bigint; usdcCosts: bigint; wethCosts: bigint }> => {
		const [greed, stock, usdc, weth] = await Promise.all([d.greed, route.stock, usdcAt, d.weth].map((at) => ethers.getContractAt(ERC20, at)));
		return { greed: await greed.balanceOf(d.treasury), stock: await stock.balanceOf(d.treasury), usdcCosts: await usdc.balanceOf(COSTS), wethCosts: await weth.balanceOf(COSTS) };
	};

	/**
	 * A mock share costs $100 and has 8 decimals, so a dollar is 1e6 stock units, the same as a dollar of test USDC. Each hop can
	 * lose up to 4%: the pool's 1% fee, plus the gap of up to 2% between the price and the first tick of a one-sided position.
	 */
	const expectPotsNear = (stockUnits: bigint, dollarUnits: bigint, hops: bigint) => {
		const potsShare = dollarUnits / 2n;
		expect(stockUnits).to.be.greaterThan((potsShare * (100n - 4n * hops)) / 100n);
		expect(stockUnits).to.be.lessThanOrEqual(potsShare);
	};

	for (const [label, usdcIn] of [
		['the cheapest price, $0.25', 250_000n],
		['the dearest single price, $3.00', 3_000_000n],
	] as const) {
		it(`payUsdc at ${label}: costs, pots and GREED each get their share and the quote is exact`, async () => {
			const pay = await payWith(usdcIn);
			const out = (await pay.quotePay.staticCall(usdcIn)) as bigint;
			const before = await balances();
			await expect(pay.payUsdc(ethers.id(label), usdcIn, (out * 97n) / 100n))
				.to.emit(pay, 'TokenPaid')
				.withArgs((await ethers.getSigners())[0].address, ethers.id(label), ethers.getAddress(usdcAt), usdcIn, out);
			const after = await balances();
			expect(after.greed - before.greed).to.equal(out);
			expect(after.usdcCosts - before.usdcCosts).to.equal(usdcIn / 10n);
			expectPotsNear(after.stock - before.stock, usdcIn, 1n);
			expect(await (await ethers.getContractAt(ERC20, route.stock)).balanceOf(payAt)).to.equal(0n);
			expect(await (await ethers.getContractAt(ERC20, usdcAt)).balanceOf(payAt)).to.equal(0n);
		});
	}

	it('pay in ETH takes two hops to the stock, and $1 of ETH buys about what $1 of USDC buys', async () => {
		const ethIn = 10n ** 18n / ETH_USD;
		const buyer = await ethers.getContractAt('GreedBuyer', buyerAt);
		const out = (await buyer.quotePay.staticCall(ethIn)) as bigint;
		const usdcOut = (await (await ethers.getContractAt('TokenPay', payAt)).quotePay.staticCall(1_000_000n)) as bigint;
		const diffBps = ((usdcOut > out ? usdcOut - out : out - usdcOut) * 10_000n) / usdcOut;
		expect(diffBps).to.be.lessThan(300n);

		const before = await balances();
		await expect(buyer.pay(ethers.id('fork-eth'), (out * 97n) / 100n, { value: ethIn })).to.emit(buyer, 'Paid');
		const after = await balances();
		expect(after.greed - before.greed).to.equal(out);
		expect(after.wethCosts - before.wethCosts).to.equal(ethIn / 10n);
		expectPotsNear(after.stock - before.stock, 1_000_000n, 2n);
		expect(await ethers.provider.getBalance(buyerAt)).to.equal(0n);
		expect(await (await ethers.getContractAt(ERC20, d.weth)).balanceOf(buyerAt)).to.equal(0n);
	});

	it('buyUsdc spends it all on GREED, exactly as quoted', async () => {
		const pay = await payWith(2_000_000n);
		const out = (await pay.quoteBuy.staticCall(2_000_000n)) as bigint;
		const [tester, , friend] = await ethers.getSigners();
		const greed = await ethers.getContractAt('MockGreed', d.greed);
		const before = await greed.balanceOf(friend.address);
		await expect(pay.buyUsdc(friend.address, 2_000_000n, (out * 97n) / 100n))
			.to.emit(pay, 'TokenBought')
			.withArgs(tester.address, friend.address, 2_000_000n, out);
		expect((await greed.balanceOf(friend.address)) - before).to.equal(out);
	});

	it('buy with ETH spends it all on GREED, exactly as quoted', async () => {
		const buyer = await ethers.getContractAt('GreedBuyer', buyerAt);
		const ethIn = 10n ** 15n;
		const out = (await buyer.quoteBuy.staticCall(ethIn)) as bigint;
		const [, , , friend] = await ethers.getSigners();
		const greed = await ethers.getContractAt('MockGreed', d.greed);
		const before = await greed.balanceOf(friend.address);
		await buyer.buy(friend.address, (out * 97n) / 100n, { value: ethIn });
		expect((await greed.balanceOf(friend.address)) - before).to.equal(out);
	});

	it('a second run of the route deployment reuses its pools and tops them up, so a failed run can be finished', async () => {
		const usdc = await ethers.getContractAt(ERC20, usdcAt);
		const before = await usdc.balanceOf(route.wethUsdcPool);
		expect(await deployRoutePools(deployer, d, usdcAt)).to.deep.equal(route);
		expect((await usdc.balanceOf(route.wethUsdcPool)) - before).to.be.greaterThan(9_999n * 10n ** 6n);
	});

	it('payUsdc reverts Slippage on the real pool when the floor is too high', async () => {
		const pay = await payWith(1_000_000n);
		await expect(pay.payUsdc(ethers.id('fork-slip'), 1_000_000n, 2n ** 255n)).to.be.revertedWithCustomError(pay, 'Slippage');
	});

	it('payGreed moves real tGREED straight to the treasury', async () => {
		const amount = 1_000n * 10n ** 18n;
		const greed = await ethers.getContractAt('MockGreed', d.greed, deployer);
		await greed.approve(payAt, amount);
		const before = await greed.balanceOf(d.treasury);
		const pay = await ethers.getContractAt('TokenPay', payAt, deployer);
		await expect(pay.payGreed(ethers.id('fork-greed'), amount)).to.emit(pay, 'TokenPaid').withArgs(DEPLOYER, ethers.id('fork-greed'), ethers.getAddress(d.greed), amount, 0n);
		expect((await greed.balanceOf(d.treasury)) - before).to.equal(amount);
	});
});

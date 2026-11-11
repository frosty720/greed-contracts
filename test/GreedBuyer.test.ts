import { expect } from 'chai';
import { ethers } from 'hardhat';
import { GREED_PER_STOCK, ONE_GREED, ONE_TO_ONE, ONE_USDC, SPLIT, freshChainEachTest, fundedPool, minted, plantToken, sentGreed } from './helpers/route-world';

const WETH_LOW = '0x0000000000000000000000000000000000001000';
const WETH_HIGH = ethers.getAddress('0xfffffffffffffffffffffffffffffffffffff000');
const USDC_AT = '0x0000000000000000000000000000000000005000';
const STOCK_AT = '0x0000000000000000000000000000000000006000';
const USDC_PER_WETH = 2n * 10n ** 9n; // MockSwapPool's rate: 1 WETH (1e18) buys $2,000 of USDC (2e9 units), so 0.001 ETH is $2
const TWO_DOLLARS = 10n ** 15n;
const QUOTE_ID = ethers.id('quote-1');

async function deployWorld(wethAt: string) {
	const [payer, treasury, costs, alice, attacker] = await ethers.getSigners();
	const weth = await plantToken(wethAt, 'MockWETH');
	const usdc = await plantToken(USDC_AT);
	const stock = await plantToken(STOCK_AT);
	const greed = await ethers.deployContract('MockGreed');
	const firstPool = await fundedPool(weth, usdc, USDC_PER_WETH, minted(usdc));
	const secondPool = await fundedPool(usdc, stock, ONE_TO_ONE, minted(stock));
	const stockPool = await fundedPool(stock, greed, GREED_PER_STOCK, sentGreed(greed));
	const route = {
		payToken: wethAt,
		firstPool: await firstPool.getAddress(),
		secondPool: await secondPool.getAddress(),
		stock: STOCK_AT,
		stockPool: await stockPool.getAddress(),
		greed: await greed.getAddress(),
		treasury: treasury.address,
		costs: costs.address,
		...SPLIT,
	};
	const buyer = await ethers.deployContract('GreedBuyer', [route]);
	return { payer, treasury, costs, alice, attacker, weth, usdc, stock, greed, firstPool, secondPool, stockPool, buyer, route };
}

for (const [label, wethAt] of [
	['WETH is token0', WETH_LOW],
	['WETH is token1', WETH_HIGH],
] as const) {
	describe(`GreedBuyer (${label})`, () => {
		freshChainEachTest();

		it('pay splits $2 of ETH into $0.20 of WETH for costs, $1.00 of stock for the pots and $0.80 of GREED, and emits Paid', async () => {
			const { payer, treasury, costs, weth, stock, greed, buyer } = await deployWorld(wethAt);
			await expect(buyer.pay(QUOTE_ID, 0, { value: TWO_DOLLARS }))
				.to.emit(buyer, 'Paid')
				.withArgs(payer.address, QUOTE_ID, TWO_DOLLARS, 200_000n * ONE_GREED);
			expect(await weth.balanceOf(costs.address)).to.equal(TWO_DOLLARS / 10n);
			expect(await stock.balanceOf(treasury.address)).to.equal(ONE_USDC);
			expect(await greed.balanceOf(treasury.address)).to.equal(200_000n * ONE_GREED);
		});

		it('buy spends all of it on GREED for the given wallet and emits Bought', async () => {
			const { payer, alice, treasury, costs, weth, stock, greed, buyer } = await deployWorld(wethAt);
			await expect(buyer.buy(alice.address, 0, { value: TWO_DOLLARS }))
				.to.emit(buyer, 'Bought')
				.withArgs(payer.address, alice.address, TWO_DOLLARS, 500_000n * ONE_GREED);
			expect(await greed.balanceOf(alice.address)).to.equal(500_000n * ONE_GREED);
			expect(await stock.balanceOf(treasury.address)).to.equal(0n);
			expect(await weth.balanceOf(costs.address)).to.equal(0n);
		});

		it('quotes exactly what pay and buy get', async () => {
			const { buyer } = await deployWorld(wethAt);
			expect(await buyer.quotePay.staticCall(TWO_DOLLARS)).to.equal(200_000n * ONE_GREED);
			expect(await buyer.quoteBuy.staticCall(TWO_DOLLARS)).to.equal(500_000n * ONE_GREED);
		});

		it('reverts Slippage below minGreedOut and changes nothing', async () => {
			const { treasury, costs, weth, stock, greed, buyer } = await deployWorld(wethAt);
			const out = 200_000n * ONE_GREED;
			await expect(buyer.pay(QUOTE_ID, out + 1n, { value: TWO_DOLLARS }))
				.to.be.revertedWithCustomError(buyer, 'Slippage')
				.withArgs(out, out + 1n);
			expect(await greed.balanceOf(treasury.address)).to.equal(0n);
			expect(await stock.balanceOf(treasury.address)).to.equal(0n);
			expect(await weth.balanceOf(costs.address)).to.equal(0n);
		});

		it('reverts ZeroValue on zero ETH', async () => {
			const { buyer, alice } = await deployWorld(wethAt);
			await expect(buyer.pay(QUOTE_ID, 0, { value: 0 })).to.be.revertedWithCustomError(buyer, 'ZeroValue');
			await expect(buyer.buy(alice.address, 0, { value: 0 })).to.be.revertedWithCustomError(buyer, 'ZeroValue');
		});

		it('reverts PartialFill when the first pool takes less than sent', async () => {
			const { firstPool, buyer } = await deployWorld(wethAt);
			await firstPool.setFillBps(9_000);
			await expect(buyer.pay(QUOTE_ID, 0, { value: TWO_DOLLARS }))
				.to.be.revertedWithCustomError(buyer, 'PartialFill')
				.withArgs((TWO_DOLLARS * 81n) / 100n, (TWO_DOLLARS * 9n) / 10n);
		});

		it('rejects a callback from anyone but its pools', async () => {
			const { buyer, attacker } = await deployWorld(wethAt);
			await expect(buyer.connect(attacker).uniswapV3SwapCallback(1, 1, '0x')).to.be.revertedWithCustomError(buyer, 'NotPool');
		});

		it('keeps no ETH, WETH or tokens on the route after pay and buy', async () => {
			const { buyer, weth, usdc, stock, greed, alice } = await deployWorld(wethAt);
			await buyer.pay(QUOTE_ID, 0, { value: 3n * TWO_DOLLARS + 7n });
			await buyer.buy(alice.address, 0, { value: TWO_DOLLARS });
			const at = await buyer.getAddress();
			expect(await ethers.provider.getBalance(at)).to.equal(0n);
			for (const token of [weth, usdc, stock, greed]) expect(await token.balanceOf(at)).to.equal(0n);
		});
	});
}

describe('GreedBuyer construction and inputs', () => {
	freshChainEachTest();

	it('refuses a route that does not start with WETH', async () => {
		const { route } = await deployWorld(WETH_LOW);
		const factory = await ethers.getContractFactory('GreedBuyer');
		await expect(factory.deploy({ ...route, firstPool: route.secondPool })).to.be.revertedWithCustomError(factory, 'BadPool');
	});

	it('refuses zero addresses', async () => {
		const { route } = await deployWorld(WETH_LOW);
		const factory = await ethers.getContractFactory('GreedBuyer');
		await expect(factory.deploy({ ...route, treasury: ethers.ZeroAddress })).to.be.revertedWithCustomError(factory, 'ZeroAddress');
	});

	it('refuses to buy for the buyer contract itself, where the GREED would be stuck', async () => {
		const { buyer } = await deployWorld(WETH_LOW);
		await expect(buyer.buy(await buyer.getAddress(), 0, { value: 1n })).to.be.revertedWithCustomError(buyer, 'BadRecipient');
	});

	it('refuses to buy for the zero address', async () => {
		const { buyer } = await deployWorld(WETH_LOW);
		await expect(buyer.buy(ethers.ZeroAddress, 0, { value: 1n })).to.be.revertedWithCustomError(buyer, 'ZeroAddress');
	});
});

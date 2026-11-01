import { expect } from 'chai';
import { ethers, network } from 'hardhat';

const WETH_LOW = '0x0000000000000000000000000000000000001000';
const WETH_HIGH = ethers.getAddress('0xfffffffffffffffffffffffffffffffffffff000');
const PRICE = 1_000_000n * 10n ** 18n; // 1 WETH buys 1,000,000 GREED
const QUOTE_ID = ethers.id('quote-1');

async function deployWorld(wethAt: string) {
	const [payer, treasury, alice, attacker] = await ethers.getSigners();
	const template = await ethers.deployContract('MockWETH');
	await network.provider.send('hardhat_setCode', [wethAt, await ethers.provider.getCode(await template.getAddress())]);
	const weth = await ethers.getContractAt('MockWETH', wethAt);
	const greed = await ethers.deployContract('MockGreed');
	const pool = await ethers.deployContract('MockSwapPool', [wethAt, await greed.getAddress(), PRICE, 10_000]);
	await greed.transfer(await pool.getAddress(), 500_000_000n * 10n ** 18n);
	const buyer = await ethers.deployContract('GreedBuyer', [wethAt, await greed.getAddress(), await pool.getAddress(), treasury.address]);
	return { payer, treasury, alice, attacker, weth, greed, pool, buyer };
}

for (const [label, wethAt] of [
	['WETH is token0', WETH_LOW],
	['WETH is token1', WETH_HIGH],
] as const) {
	describe(`GreedBuyer (${label})`, () => {
		it('sorts WETH on the expected side of the pool', async () => {
			const { pool } = await deployWorld(wethAt);
			expect((await pool.token0()) === wethAt).to.equal(wethAt === WETH_LOW);
		});

		it('pay sends all the GREED to the treasury and emits Paid', async () => {
			const { payer, treasury, greed, buyer } = await deployWorld(wethAt);
			const ethIn = 5n * 10n ** 17n;
			const out = 500_000n * 10n ** 18n;
			await expect(buyer.pay(QUOTE_ID, 0, { value: ethIn }))
				.to.emit(buyer, 'Paid')
				.withArgs(payer.address, QUOTE_ID, ethIn, out);
			expect(await greed.balanceOf(treasury.address)).to.equal(out);
		});

		it('buy sends the GREED to the given wallet and emits Bought', async () => {
			const { payer, alice, greed, buyer } = await deployWorld(wethAt);
			const ethIn = 10n ** 17n;
			const out = 100_000n * 10n ** 18n;
			await expect(buyer.buy(alice.address, 0, { value: ethIn }))
				.to.emit(buyer, 'Bought')
				.withArgs(payer.address, alice.address, ethIn, out);
			expect(await greed.balanceOf(alice.address)).to.equal(out);
		});

		it('reverts Slippage below minGreedOut and changes nothing', async () => {
			const { treasury, greed, buyer } = await deployWorld(wethAt);
			const out = 100_000n * 10n ** 18n;
			await expect(buyer.pay(QUOTE_ID, out + 1n, { value: 10n ** 17n }))
				.to.be.revertedWithCustomError(buyer, 'Slippage')
				.withArgs(out, out + 1n);
			expect(await greed.balanceOf(treasury.address)).to.equal(0n);
		});

		it('reverts ZeroValue on zero ETH', async () => {
			const { buyer, alice } = await deployWorld(wethAt);
			await expect(buyer.pay(QUOTE_ID, 0, { value: 0 })).to.be.revertedWithCustomError(buyer, 'ZeroValue');
			await expect(buyer.buy(alice.address, 0, { value: 0 })).to.be.revertedWithCustomError(buyer, 'ZeroValue');
		});

		it('reverts PartialFill when the pool takes less than sent', async () => {
			const { pool, buyer } = await deployWorld(wethAt);
			await pool.setFillBps(9_000);
			await expect(buyer.pay(QUOTE_ID, 0, { value: 10n ** 17n }))
				.to.be.revertedWithCustomError(buyer, 'PartialFill')
				.withArgs(9n * 10n ** 16n, 10n ** 17n);
		});

		it('rejects a callback from anyone but the pool', async () => {
			const { buyer, attacker } = await deployWorld(wethAt);
			await expect(buyer.connect(attacker).uniswapV3SwapCallback(1, 1, '0x')).to.be.revertedWithCustomError(buyer, 'NotPool');
		});

		it('keeps no ETH or WETH after pay and buy', async () => {
			const { buyer, weth, alice } = await deployWorld(wethAt);
			await buyer.pay(QUOTE_ID, 0, { value: 3n * 10n ** 17n });
			await buyer.buy(alice.address, 0, { value: 2n * 10n ** 17n });
			const at = await buyer.getAddress();
			expect(await ethers.provider.getBalance(at)).to.equal(0n);
			expect(await weth.balanceOf(at)).to.equal(0n);
		});
	});
}

describe('GreedBuyer construction and inputs', () => {
	it('refuses a pool that does not trade WETH against GREED', async () => {
		const { treasury, weth, greed } = await deployWorld(WETH_LOW);
		const other = await ethers.deployContract('MockGreed');
		const wrongPool = await ethers.deployContract('MockSwapPool', [await weth.getAddress(), await other.getAddress(), PRICE, 10_000]);
		const factory = await ethers.getContractFactory('GreedBuyer');
		await expect(
			factory.deploy(await weth.getAddress(), await greed.getAddress(), await wrongPool.getAddress(), treasury.address),
		).to.be.revertedWithCustomError(factory, 'BadPool');
	});

	it('refuses zero addresses', async () => {
		const { weth, greed, pool } = await deployWorld(WETH_LOW);
		const factory = await ethers.getContractFactory('GreedBuyer');
		await expect(
			factory.deploy(await weth.getAddress(), await greed.getAddress(), await pool.getAddress(), ethers.ZeroAddress),
		).to.be.revertedWithCustomError(factory, 'ZeroAddress');
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

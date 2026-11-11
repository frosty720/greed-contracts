import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { GREED_PER_STOCK, ONE_GREED, ONE_TO_ONE, ONE_USDC, SPLIT, freshChainEachTest, fundedPool, minted, plantToken, sentGreed } from './helpers/route-world';

const LOW = {
	usdc: '0x0000000000000000000000000000000000001000',
	stock: '0x0000000000000000000000000000000000002000',
	middle: '0x0000000000000000000000000000000000003000',
};
const HIGH = {
	usdc: ethers.getAddress('0xfffffffffffffffffffffffffffffffffffff000'),
	stock: ethers.getAddress('0xffffffffffffffffffffffffffffffffffffe000'),
	middle: ethers.getAddress('0xffffffffffffffffffffffffffffffffffffd000'),
};
const QUOTE_ID = ethers.id('quote-1');

interface Places {
	usdc: string;
	stock: string;
	middle: string;
}

async function deployWorld(at: Places, twoHops = false) {
	const [payer, treasury, costs, other] = await ethers.getSigners();
	const usdc = await plantToken(at.usdc);
	const stock = await plantToken(at.stock);
	const middle = twoHops ? await plantToken(at.middle) : null;
	const greed = await ethers.deployContract('MockGreed');
	const firstPool = await fundedPool(usdc, middle ?? stock, ONE_TO_ONE, minted(middle ?? stock));
	const secondPool = middle ? await fundedPool(middle, stock, ONE_TO_ONE, minted(stock)) : null;
	const stockPool = await fundedPool(stock, greed, GREED_PER_STOCK, sentGreed(greed));
	const route = {
		payToken: at.usdc,
		firstPool: await firstPool.getAddress(),
		secondPool: secondPool ? await secondPool.getAddress() : ethers.ZeroAddress,
		stock: at.stock,
		stockPool: await stockPool.getAddress(),
		greed: await greed.getAddress(),
		treasury: treasury.address,
		costs: costs.address,
		...SPLIT,
	};
	const pay = await ethers.deployContract('TokenPay', [route]);
	const payAt = await pay.getAddress();
	await usdc.mint(payer.address, 100n * ONE_USDC);
	await usdc.approve(payAt, ethers.MaxUint256);
	await greed.approve(payAt, ethers.MaxUint256);
	return { payer, treasury, costs, other, usdc, stock, greed, firstPool, secondPool, stockPool, pay, payAt, route };
}

for (const [label, at] of [
	['tokens sort low in every pool', LOW],
	['tokens sort high in every pool', HIGH],
] as const) {
	describe(`TokenPay (${label})`, () => {
		freshChainEachTest();

		it('payUsdc splits $2 into $0.20 for costs, $1.00 of stock for the pots and $0.80 of GREED for the treasury', async () => {
			const { payer, treasury, costs, usdc, stock, greed, pay } = await deployWorld(at);
			const before = await usdc.balanceOf(payer.address);
			await expect(pay.payUsdc(QUOTE_ID, 2n * ONE_USDC, 0))
				.to.emit(pay, 'TokenPaid')
				.withArgs(payer.address, QUOTE_ID, at.usdc, 2n * ONE_USDC, 200_000n * ONE_GREED);
			expect(await usdc.balanceOf(payer.address)).to.equal(before - 2n * ONE_USDC);
			expect(await usdc.balanceOf(costs.address)).to.equal(200_000n);
			expect(await stock.balanceOf(treasury.address)).to.equal(1_000_000n);
			expect(await greed.balanceOf(treasury.address)).to.equal(200_000n * ONE_GREED);
		});

		it('names the USDC it takes, which the Shop reads to know what to approve', async () => {
			const { pay } = await deployWorld(at);
			expect(await pay.usdc()).to.equal(at.usdc);
		});

		it('payUsdc works through two hops to the stock', async () => {
			const { treasury, costs, usdc, stock, greed, pay } = await deployWorld(at, true);
			await pay.payUsdc(QUOTE_ID, 2n * ONE_USDC, 0);
			expect(await usdc.balanceOf(costs.address)).to.equal(200_000n);
			expect(await stock.balanceOf(treasury.address)).to.equal(1_000_000n);
			expect(await greed.balanceOf(treasury.address)).to.equal(200_000n * ONE_GREED);
		});

		it('payUsdc reverts Slippage below the floor and takes nothing', async () => {
			const { payer, treasury, costs, usdc, stock, greed, pay } = await deployWorld(at);
			const before = await usdc.balanceOf(payer.address);
			await expect(pay.payUsdc(QUOTE_ID, 2n * ONE_USDC, 200_000n * ONE_GREED + 1n))
				.to.be.revertedWithCustomError(pay, 'Slippage')
				.withArgs(200_000n * ONE_GREED, 200_000n * ONE_GREED + 1n);
			expect(await greed.balanceOf(treasury.address)).to.equal(0n);
			expect(await stock.balanceOf(treasury.address)).to.equal(0n);
			expect(await usdc.balanceOf(costs.address)).to.equal(0n);
			expect(await usdc.balanceOf(payer.address)).to.equal(before);
		});

		it('payUsdc reverts PartialFill when the first pool takes less than given', async () => {
			const { firstPool, pay } = await deployWorld(at);
			await firstPool.setFillBps(9_000);
			await expect(pay.payUsdc(QUOTE_ID, 2n * ONE_USDC, 0))
				.to.be.revertedWithCustomError(pay, 'PartialFill')
				.withArgs(1_620_000n, 1_800_000n);
		});

		it('payUsdc reverts PartialFill when the GREED pool takes less than given', async () => {
			const { stockPool, pay } = await deployWorld(at);
			await stockPool.setFillBps(5_000);
			await expect(pay.payUsdc(QUOTE_ID, 2n * ONE_USDC, 0))
				.to.be.revertedWithCustomError(pay, 'PartialFill')
				.withArgs(400_000n, 800_000n);
		});

		it('buyUsdc spends all of it on GREED for the wallet, with nothing to costs or the pots', async () => {
			const { payer, other, treasury, costs, usdc, stock, greed, pay } = await deployWorld(at);
			const before = await usdc.balanceOf(payer.address);
			await expect(pay.buyUsdc(other.address, 2n * ONE_USDC, 0))
				.to.emit(pay, 'TokenBought')
				.withArgs(payer.address, other.address, 2n * ONE_USDC, 500_000n * ONE_GREED);
			expect(await greed.balanceOf(other.address)).to.equal(500_000n * ONE_GREED);
			expect(await greed.balanceOf(treasury.address)).to.equal(0n);
			expect(await stock.balanceOf(treasury.address)).to.equal(0n);
			expect(await usdc.balanceOf(costs.address)).to.equal(0n);
			expect(await usdc.balanceOf(payer.address)).to.equal(before - 2n * ONE_USDC);
		});

		it('buyUsdc reverts Slippage below the floor and takes nothing', async () => {
			const { payer, other, usdc, greed, pay } = await deployWorld(at);
			const before = await usdc.balanceOf(payer.address);
			await expect(pay.buyUsdc(other.address, ONE_USDC, 250_000n * ONE_GREED + 1n))
				.to.be.revertedWithCustomError(pay, 'Slippage')
				.withArgs(250_000n * ONE_GREED, 250_000n * ONE_GREED + 1n);
			expect(await greed.balanceOf(other.address)).to.equal(0n);
			expect(await usdc.balanceOf(payer.address)).to.equal(before);
		});

		it('keeps nothing after a payment or a buy, rounding included', async () => {
			const { usdc, stock, greed, pay, payAt, other } = await deployWorld(at);
			await pay.payUsdc(QUOTE_ID, 3n * ONE_USDC + 7n, 0);
			await pay.buyUsdc(other.address, 2n * ONE_USDC, 0);
			await pay.payGreed(QUOTE_ID, ONE_GREED);
			expect(await usdc.balanceOf(payAt)).to.equal(0n);
			expect(await stock.balanceOf(payAt)).to.equal(0n);
			expect(await greed.balanceOf(payAt)).to.equal(0n);
		});

		it('rounds in favour of the GREED buy on a tiny payment', async () => {
			const { treasury, costs, usdc, stock, greed, pay } = await deployWorld(at);
			await pay.payUsdc(QUOTE_ID, 3n, 0);
			expect(await usdc.balanceOf(costs.address)).to.equal(0n);
			expect(await stock.balanceOf(treasury.address)).to.equal(1n);
			expect(await greed.balanceOf(treasury.address)).to.equal(2n * (GREED_PER_STOCK / ONE_TO_ONE));
		});

		it('quotePay and quoteBuy give exactly what a payment and a buy get', async () => {
			const { pay } = await deployWorld(at);
			expect(await pay.quotePay.staticCall(2n * ONE_USDC)).to.equal(200_000n * ONE_GREED);
			expect(await pay.quoteBuy.staticCall(2n * ONE_USDC)).to.equal(500_000n * ONE_GREED);
		});

		it('quotes through two hops to the stock', async () => {
			const { pay } = await deployWorld(at, true);
			expect(await pay.quotePay.staticCall(2n * ONE_USDC)).to.equal(200_000n * ONE_GREED);
			expect(await pay.quoteBuy.staticCall(2n * ONE_USDC)).to.equal(500_000n * ONE_GREED);
		});

		it('a quote sent as a real transaction moves nothing', async () => {
			const { stock, greed, pay, firstPool, stockPool } = await deployWorld(at);
			const before = [await stock.balanceOf(await firstPool.getAddress()), await greed.balanceOf(await stockPool.getAddress())];
			await pay.quotePay(2n * ONE_USDC);
			expect([await stock.balanceOf(await firstPool.getAddress()), await greed.balanceOf(await stockPool.getAddress())]).to.deep.equal(before);
		});

		it('a quote refuses an amount the pool could not fill, as the payment would', async () => {
			const { stockPool, pay } = await deployWorld(at);
			await stockPool.setFillBps(5_000);
			await expect(pay.quotePay.staticCall(2n * ONE_USDC))
				.to.be.revertedWithCustomError(pay, 'PartialFill')
				.withArgs(400_000n, 800_000n);
		});

		it("a quote passes on a pool's own failure instead of reading it as a price", async () => {
			const { pay, firstPool, stock } = await deployWorld(at);
			await network.provider.send('hardhat_impersonateAccount', [await firstPool.getAddress()]);
			await network.provider.send('hardhat_setBalance', [await firstPool.getAddress(), '0x56BC75E2D63100000']);
			const emptied = await stock.connect(await ethers.getSigner(await firstPool.getAddress()));
			await emptied.transfer(ethers.Wallet.createRandom().address, await stock.balanceOf(await firstPool.getAddress()));
			await expect(pay.quotePay.staticCall(2n * ONE_USDC)).to.be.revertedWithCustomError(stock, 'ERC20InsufficientBalance');
		});
	});
}

describe('TokenPay payGreed', () => {
	freshChainEachTest();

	it('sends the GREED straight to the treasury and logs nothing bought', async () => {
		const { payer, treasury, greed, pay } = await deployWorld(LOW);
		const before = await greed.balanceOf(payer.address);
		const amount = 1_000n * ONE_GREED;
		await expect(pay.payGreed(QUOTE_ID, amount))
			.to.emit(pay, 'TokenPaid')
			.withArgs(payer.address, QUOTE_ID, await greed.getAddress(), amount, 0n);
		expect(await greed.balanceOf(treasury.address)).to.equal(amount);
		expect(await greed.balanceOf(payer.address)).to.equal(before - amount);
	});

	it('takes no cut for costs or the pots and does not touch a pool', async () => {
		const { costs, treasury, stock, greed, stockPool, pay } = await deployWorld(LOW);
		const before = await greed.balanceOf(await stockPool.getAddress());
		await pay.payGreed(QUOTE_ID, ONE_GREED);
		expect(await greed.balanceOf(await stockPool.getAddress())).to.equal(before);
		expect(await greed.balanceOf(costs.address)).to.equal(0n);
		expect(await stock.balanceOf(treasury.address)).to.equal(0n);
	});
});

describe('TokenPay refusals', () => {
	freshChainEachTest();

	it('refuses a zero amount in either token, and a zero buy', async () => {
		const { pay, other } = await deployWorld(LOW);
		await expect(pay.payUsdc(QUOTE_ID, 0, 0)).to.be.revertedWithCustomError(pay, 'ZeroAmount');
		await expect(pay.payGreed(QUOTE_ID, 0)).to.be.revertedWithCustomError(pay, 'ZeroAmount');
		await expect(pay.buyUsdc(other.address, 0, 0)).to.be.revertedWithCustomError(pay, 'ZeroAmount');
	});

	it('refuses to buy for the zero address, or for TokenPay itself where the GREED would be stuck', async () => {
		const { pay, payAt } = await deployWorld(LOW);
		await expect(pay.buyUsdc(ethers.ZeroAddress, ONE_USDC, 0)).to.be.revertedWithCustomError(pay, 'ZeroAddress');
		await expect(pay.buyUsdc(payAt, ONE_USDC, 0)).to.be.revertedWithCustomError(pay, 'BadRecipient');
	});

	it('only ever pulls from the caller, even from a wallet that approved it', async () => {
		const { other, payer, usdc, greed, pay } = await deployWorld(LOW);
		const before = await usdc.balanceOf(payer.address);
		await expect(pay.connect(other).payUsdc(QUOTE_ID, ONE_USDC, 0)).to.be.reverted;
		await expect(pay.connect(other).payGreed(QUOTE_ID, 1n)).to.be.reverted;
		expect(await usdc.balanceOf(payer.address)).to.equal(before);
		expect(await greed.balanceOf(other.address)).to.equal(0n);
	});

	it('refuses an amount too large for a swap instead of reading it as an exact-output swap', async () => {
		const { pay, payer, other } = await deployWorld(LOW);
		const huge = 2n ** 255n;
		// No mint can make a balance this big, so it's written straight into OpenZeppelin ERC20's balance mapping (slot 0).
		const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [payer.address, 0]));
		await network.provider.send('hardhat_setStorageAt', [LOW.usdc, slot, ethers.toBeHex(huge, 32)]);
		await expect(pay.buyUsdc(other.address, huge, 0)).to.be.revertedWithCustomError(pay, 'SafeCastOverflowedUintToInt');
	});

	it('rejects a callback from anyone but its pools, in quote mode too', async () => {
		const { pay, other } = await deployWorld(LOW);
		await expect(pay.connect(other).uniswapV3SwapCallback(1, 1, '0x')).to.be.revertedWithCustomError(pay, 'NotPool');
		await expect(pay.connect(other).uniswapV3SwapCallback(1, -1, '0x01')).to.be.revertedWithCustomError(pay, 'NotPool');
	});
});

describe('TokenPay construction', () => {
	freshChainEachTest();

	const refused = async (change: (r: Awaited<ReturnType<typeof deployWorld>>['route']) => object, error: string) => {
		const { route } = await deployWorld(LOW);
		const factory = await ethers.getContractFactory('TokenPay');
		await expect(factory.deploy({ ...route, ...change(route) })).to.be.revertedWithCustomError(factory, error);
	};

	it('refuses a first pool that does not trade the pay token', async () => {
		await refused((route) => ({ firstPool: route.stockPool }), 'BadPool');
	});

	it('refuses a one-hop route whose first pool does not reach the stock', async () => {
		const { route } = await deployWorld(HIGH, true);
		const factory = await ethers.getContractFactory('TokenPay');
		await expect(factory.deploy({ ...route, secondPool: ethers.ZeroAddress })).to.be.revertedWithCustomError(factory, 'BadPool');
	});

	it('refuses a second pool that does not lead to the stock', async () => {
		const { route } = await deployWorld(HIGH, true);
		const factory = await ethers.getContractFactory('TokenPay');
		await expect(factory.deploy({ ...route, secondPool: route.firstPool })).to.be.revertedWithCustomError(factory, 'BadPool');
	});

	it('refuses a last pool that does not trade the stock against GREED', async () => {
		const { route } = await deployWorld(LOW);
		const factory = await ethers.getContractFactory('TokenPay');
		await expect(factory.deploy({ ...route, stockPool: route.firstPool })).to.be.revertedWithCustomError(factory, 'BadPool');
	});

	it('refuses a split that leaves nothing to buy GREED', async () => {
		await refused(() => ({ costsBps: 5000, potsBps: 5000 }), 'BadSplit');
		await refused(() => ({ costsBps: 0, potsBps: 10_000 }), 'BadSplit');
	});

	it('refuses zero addresses', async () => {
		await refused(() => ({ treasury: ethers.ZeroAddress }), 'ZeroAddress');
		await refused(() => ({ costs: ethers.ZeroAddress }), 'ZeroAddress');
		await refused(() => ({ stock: ethers.ZeroAddress }), 'ZeroAddress');
	});
});

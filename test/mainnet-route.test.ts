import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { BASE } from '../scripts/lib/mainnet';
import { BASE_ROUTE, PayBroadcast, RouteLegs, SimulatedSize, deployPayContracts, payRoutes, requireBought, requireGreedPool, simulateRoute, slippagePercent } from '../scripts/lib/mainnet-route';
import { GREED_PER_STOCK, ONE_GREED, ONE_TO_ONE, ONE_USDC, SPLIT, freshChainEachTest, fundedPool, minted, plantToken, sentGreed } from './helpers/route-world';

const WETH_AT = '0x0000000000000000000000000000000000001000';
const USDC_AT = '0x0000000000000000000000000000000000005000';
const STOCK_AT = '0x0000000000000000000000000000000000006000';
const USDC_PER_WETH = 2n * 10n ** 9n; // 1 WETH buys $2,000, so 0.001 ETH is $2
const TWO_DOLLARS_ETH = 10n ** 15n;
const FACTORY = '0x00000000000000000000000000000000000fac70';

const rejection = async (promise: Promise<unknown>): Promise<string> => {
	try {
		await promise;
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error('expected a rejection');
};

/** A mock market shaped like Base's: WETH to USDC, USDC to the stock, and GREED's own pool against the stock on the launchpad's factory. */
async function world() {
	const [payer, treasury, costs] = await ethers.getSigners();
	const weth = await plantToken(WETH_AT, 'MockWETH');
	const usdc = await plantToken(USDC_AT);
	const stock = await plantToken(STOCK_AT);
	const greed = await ethers.deployContract('MockGreed');
	const wethUsdc = await fundedPool(weth, usdc, USDC_PER_WETH, minted(usdc));
	const stockUsdc = await fundedPool(usdc, stock, ONE_TO_ONE, minted(stock));
	const greedPool = await ethers.deployContract('MockListedPool', [STOCK_AT, await greed.getAddress(), GREED_PER_STOCK, FACTORY, 1_000_000n]);
	await sentGreed(greed)(await greedPool.getAddress());
	const legs: RouteLegs = { weth: WETH_AT, usdc: USDC_AT, stock: STOCK_AT, wethUsdcPool: await wethUsdc.getAddress(), stockUsdcPool: await stockUsdc.getAddress() };
	const ends = { greed: await greed.getAddress(), greedPool: await greedPool.getAddress(), treasury: treasury.address, costs: costs.address };
	return { payer, treasury, costs, weth, usdc, stock, greed, greedPool, legs, ends, routes: payRoutes(ends, legs) };
}

describe('GREED payment route on Base', () => {
	describe('payRoutes', () => {
		const ends = { greed: '0x00000000000000000000000000000000000000a1', greedPool: '0x00000000000000000000000000000000000000a2', treasury: '0x00000000000000000000000000000000000000a3', costs: '0x00000000000000000000000000000000000000a4' };

		it('ETH goes WETH to USDC to GOOGLc, and USDC goes straight to GOOGLc: nobody pays in the stock', () => {
			const { buyer, tokenPay } = payRoutes(ends);
			expect(buyer).to.include({ payToken: BASE.weth, firstPool: BASE_ROUTE.wethUsdcPool, secondPool: BASE_ROUTE.googlUsdcPool });
			expect(tokenPay).to.include({ payToken: BASE.usdc, firstPool: BASE_ROUTE.googlUsdcPool, secondPool: ethers.ZeroAddress });
		});

		it('both end on the stock, GREED and its pool, pay the same treasury and costs, and carry the 10% and 50% split', () => {
			const { buyer, tokenPay } = payRoutes(ends);
			for (const route of [buyer, tokenPay]) {
				// Addresses come back checksummed, whatever case they were given in.
				expect(route).to.include({ stock: BASE_ROUTE.googl, stockPool: ethers.getAddress(ends.greedPool.toLowerCase()), greed: ethers.getAddress(ends.greed.toLowerCase()), treasury: ethers.getAddress(ends.treasury.toLowerCase()), costs: ethers.getAddress(ends.costs.toLowerCase()) });
				expect(route).to.include(SPLIT);
			}
		});

		it('refuses a missing or zero address before anything permanent could be deployed with it', () => {
			expect(() => payRoutes({ ...ends, greedPool: 'nope' })).to.throw('greedPool must be an address');
			expect(() => payRoutes({ ...ends, costs: ethers.ZeroAddress })).to.throw('costs must be an address');
		});
	});

	describe('requireGreedPool', () => {
		freshChainEachTest();

		it('accepts the launchpad pool of GREED against the stock, and reads its liquidity', async () => {
			const { ends } = await world();
			expect(await requireGreedPool(ethers.provider, ends.greedPool, ends.greed, STOCK_AT, FACTORY)).to.deep.equal({ liquidity: 1_000_000n });
		});

		it('refuses something that is not an address, a plain wallet and a contract that is not a pool', async () => {
			const { ends, payer, greed } = await world();
			expect(await rejection(requireGreedPool(ethers.provider, 'nope', ends.greed, STOCK_AT, FACTORY))).to.contain('must be addresses');
			expect(await rejection(requireGreedPool(ethers.provider, payer.address, ends.greed, STOCK_AT, FACTORY))).to.contain('has no contract');
			expect(await rejection(requireGreedPool(ethers.provider, await greed.getAddress(), ends.greed, STOCK_AT, FACTORY))).to.contain('not a pool the route can swap on');
		});

		it('refuses a pool that trades other tokens: GREED against USDC is not GREED against the stock', async () => {
			const { ends, greed } = await world();
			const wrong = await ethers.deployContract('MockListedPool', [USDC_AT, await greed.getAddress(), ONE_TO_ONE, FACTORY, 1n]);
			expect(await rejection(requireGreedPool(ethers.provider, await wrong.getAddress(), ends.greed, STOCK_AT, FACTORY))).to.contain('does not trade GREED');
			// And the stock paired with itself is no pool of GREED either.
			expect(await rejection(requireGreedPool(ethers.provider, ends.greedPool, STOCK_AT, STOCK_AT, FACTORY))).to.contain('does not trade GREED');
		});

		it("refuses a look-alike pool from another factory, and one with no liquidity to buy from", async () => {
			const { ends, greed, greedPool } = await world();
			const other = await ethers.deployContract('MockListedPool', [STOCK_AT, await greed.getAddress(), GREED_PER_STOCK, WETH_AT, 1n]);
			expect(await rejection(requireGreedPool(ethers.provider, await other.getAddress(), ends.greed, STOCK_AT, FACTORY))).to.contain("not the launchpad's factory");
			await greedPool.setLiquidity(0);
			expect(await rejection(requireGreedPool(ethers.provider, ends.greedPool, ends.greed, STOCK_AT, FACTORY))).to.contain('no liquidity');
		});
	});

	describe('simulateRoute', () => {
		freshChainEachTest();

		it('quotes a USDC payment and a Shop buy exactly as the deployed contract would, without deploying anything', async () => {
			const { routes, treasury, stock, greed } = await world();
			const block = await ethers.provider.getBlockNumber();
			const [two] = await simulateRoute(ethers.provider, 'TokenPay', routes.tokenPay, [2n * ONE_USDC]);
			// $2: $0.20 costs, $1.00 of stock to the pots, $0.80 buys GREED at 250,000 a dollar. A Shop buy spends all $2.
			expect(two).to.deep.equal({ amountIn: 2n * ONE_USDC, quotePay: 200_000n * ONE_GREED, quoteBuy: 500_000n * ONE_GREED, pay: null, buy: null });
			const real = await ethers.deployContract('TokenPay', [routes.tokenPay]);
			expect(await real.quotePay.staticCall(2n * ONE_USDC)).to.equal(two.quotePay);
			// Nothing was sent by the simulation: one block for the real deploy just above, and no tokens moved.
			expect(await ethers.provider.getBlockNumber()).to.equal(block + 1);
			expect(await stock.balanceOf(treasury.address)).to.equal(0n);
			expect(await greed.balanceOf(treasury.address)).to.equal(0n);
		});

		it('runs a USDC payment in full from a holder of USDC, and it matches the quote and moves nothing for real', async () => {
			const { routes, treasury, costs, usdc, stock, greed } = await world();
			const holder = '0x0000000000000000000000000000000000b01de2';
			await usdc.mint(holder, 2n * ONE_USDC);
			const [two] = await simulateRoute(ethers.provider, 'TokenPay', routes.tokenPay, [2n * ONE_USDC], holder);
			expect(two.pay).to.equal(200_000n * ONE_GREED);
			expect(two.pay).to.equal(two.quotePay);
			expect(two.buy).to.equal(null);
			// Only simulated: the holder still has its USDC and no code, and nobody was paid.
			expect(await usdc.balanceOf(holder)).to.equal(2n * ONE_USDC);
			expect(await ethers.provider.getCode(holder)).to.equal('0x');
			expect(await usdc.balanceOf(costs.address)).to.equal(0n);
			expect(await stock.balanceOf(treasury.address)).to.equal(0n);
			expect(await greed.balanceOf(treasury.address)).to.equal(0n);
		});

		it('a USDC payment that could not be made fails the simulation, naming the step', async () => {
			const { routes } = await world();
			// This holder has no USDC, as a costs wallet that could not be paid would also revert the whole payment.
			const empty = '0x0000000000000000000000000000000000e3b7e1';
			expect(await rejection(simulateRoute(ethers.provider, 'TokenPay', routes.tokenPay, [2n * ONE_USDC], empty))).to.contain('TokenPay: payUsdc of 2000000 failed');
		});

		it('runs an ETH payment and buy in full, tokens moving, and they match the quotes and the deployed contract', async () => {
			const { routes, treasury, greed, weth, costs } = await world();
			const [two] = await simulateRoute(ethers.provider, 'GreedBuyer', routes.buyer, [TWO_DOLLARS_ETH]);
			expect(two).to.deep.equal({ amountIn: TWO_DOLLARS_ETH, quotePay: 200_000n * ONE_GREED, quoteBuy: 500_000n * ONE_GREED, pay: 200_000n * ONE_GREED, buy: 500_000n * ONE_GREED });
			// Still only simulated: the treasury and the costs wallet hold nothing.
			expect(await greed.balanceOf(treasury.address)).to.equal(0n);
			expect(await weth.balanceOf(costs.address)).to.equal(0n);
			const real = await ethers.deployContract('GreedBuyer', [routes.buyer]);
			await real.pay(ethers.id('real'), two.pay ?? 0n, { value: TWO_DOLLARS_ETH });
			expect(await greed.balanceOf(treasury.address)).to.equal(two.pay);
		});

		it('quotes every size asked, in order', async () => {
			const { routes } = await world();
			const sizes = await simulateRoute(ethers.provider, 'TokenPay', routes.tokenPay, [ONE_USDC, 5n * ONE_USDC]);
			expect(sizes.map((s) => [s.amountIn, s.quoteBuy])).to.deep.equal([
				[ONE_USDC, 250_000n * ONE_GREED],
				[5n * ONE_USDC, 1_250_000n * ONE_GREED],
			]);
		});

		it('fails where a real deploy would: a route whose pool does not hold the token is refused by the constructor', async () => {
			const { routes, legs } = await world();
			const broken = { ...routes.tokenPay, firstPool: legs.wethUsdcPool, payToken: STOCK_AT };
			expect(await rejection(simulateRoute(ethers.provider, 'TokenPay', broken, [ONE_USDC]))).to.contain('TokenPay: its constructor refused the route');
		});

		it('fails where a real payment would: a GREED pool with nothing left to sell', async () => {
			const { ends, legs, greed } = await world();
			const empty = await ethers.deployContract('MockListedPool', [STOCK_AT, await greed.getAddress(), GREED_PER_STOCK, FACTORY, 1n]);
			const routes = payRoutes({ ...ends, greedPool: await empty.getAddress() }, legs);
			expect(await rejection(simulateRoute(ethers.provider, 'TokenPay', routes.tokenPay, [ONE_USDC]))).to.contain('TokenPay: quotePay of 1000000 failed');
		});

		it('an error from the node never carries its address', async () => {
			const { routes } = await world();
			const leaky = { send: async () => Promise.reject(new Error('could not reach https://8453.rpc.example.com/secret-id')) };
			const message = await rejection(simulateRoute(leaky, 'TokenPay', routes.tokenPay, [ONE_USDC]));
			expect(message).to.contain('<rpc-url>');
			expect(message).not.to.contain('secret-id');
		});
	});

	describe('reading a simulation', () => {
		const size = (amountIn: bigint, quoteBuy: bigint, rest: Partial<SimulatedSize> = {}): SimulatedSize => ({ amountIn, quotePay: 1n, quoteBuy, pay: null, buy: null, ...rest });

		it('slippage is how much less per unit the largest size gets than the smallest', () => {
			expect(slippagePercent([size(1n * ONE_USDC, 1000n), size(100n * ONE_USDC, 99_000n)])).to.be.closeTo(1, 1e-9);
			expect(slippagePercent([size(ONE_USDC, 1000n), size(5n * ONE_USDC, 5000n)])).to.equal(0);
			expect(slippagePercent([size(ONE_USDC, 1000n)])).to.equal(0);
			expect(slippagePercent([size(ONE_USDC, 0n), size(5n * ONE_USDC, 0n)])).to.equal(0);
		});

		it('a route is only proven if every size bought GREED, in the quotes and in the full runs', () => {
			expect(() => requireBought('TokenPay', [size(ONE_USDC, 5n)])).not.to.throw();
			expect(() => requireBought('TokenPay', [size(ONE_USDC, 5n), size(2n * ONE_USDC, 0n)])).to.throw('TokenPay: a payment of 2000000 bought no GREED');
			expect(() => requireBought('GreedBuyer', [size(ONE_USDC, 5n, { pay: 3n, buy: 0n })])).to.throw('bought no GREED');
			expect(() => requireBought('GreedBuyer', [size(ONE_USDC, 5n, { quotePay: 0n })])).to.throw('bought no GREED');
		});
	});

	describe('deployPayContracts', () => {
		freshChainEachTest();

		it('deploys GreedBuyer then TokenPay on their routes, paying the treasury and the costs wallet given', async () => {
			const { routes, payer, treasury, costs, ends } = await world();
			const sent: PayBroadcast[] = [];
			const deployment = await deployPayContracts(payer, routes, (b) => void sent.push(b));
			expect(sent.map((b) => [b.contract, b.address])).to.deep.equal([
				['GreedBuyer', deployment.buyer],
				['TokenPay', deployment.tokenPay],
			]);
			const buyer = await ethers.getContractAt('GreedBuyer', deployment.buyer);
			const tokenPay = await ethers.getContractAt('TokenPay', deployment.tokenPay);
			expect([await buyer.payToken(), await buyer.firstPool(), await buyer.secondPool()]).to.deep.equal([routes.buyer.payToken, routes.buyer.firstPool, routes.buyer.secondPool]);
			expect([await tokenPay.payToken(), await tokenPay.firstPool(), await tokenPay.secondPool()]).to.deep.equal([USDC_AT, routes.tokenPay.firstPool, ethers.ZeroAddress]);
			for (const contract of [buyer, tokenPay]) {
				expect([await contract.stock(), await contract.greed(), await contract.treasury(), await contract.costs()]).to.deep.equal([STOCK_AT, ends.greed, treasury.address, costs.address]);
				expect([await contract.costsBps(), await contract.potsBps()]).to.deep.equal([1000n, 5000n]);
			}
			expect(deployment.block).to.equal(await ethers.provider.getBlockNumber());
		});

		it('the deployed pair really takes a payment each: ETH through three pools, USDC through two', async () => {
			const { routes, payer, treasury, usdc, greed, stock } = await world();
			const deployment = await deployPayContracts(payer, routes);
			const buyer = await ethers.getContractAt('GreedBuyer', deployment.buyer);
			const tokenPay = await ethers.getContractAt('TokenPay', deployment.tokenPay);
			await buyer.pay(ethers.id('eth'), 0, { value: TWO_DOLLARS_ETH });
			await usdc.mint(payer.address, 2n * ONE_USDC);
			await usdc.approve(deployment.tokenPay, 2n * ONE_USDC);
			await tokenPay.payUsdc(ethers.id('usdc'), 2n * ONE_USDC, 0);
			// Two $2 payments: $1.00 of stock each to the pots, 200,000 GREED each to the treasury.
			expect(await stock.balanceOf(treasury.address)).to.equal(2n * ONE_USDC);
			expect(await greed.balanceOf(treasury.address)).to.equal(400_000n * ONE_GREED);
		});

		it('hands over each transaction before waiting for it, so a dropped connection still leaves a record', async () => {
			const { routes, payer } = await world();
			const receipts: unknown[] = [];
			await network.provider.send('evm_setAutomine', [false]);
			try {
				await deployPayContracts(payer, routes, async (broadcast) => {
					receipts.push(await ethers.provider.getTransactionReceipt(broadcast.txHash));
					await network.provider.send('evm_mine');
				});
			} finally {
				await network.provider.send('evm_setAutomine', [true]);
			}
			expect(receipts).to.deep.equal([null, null]);
		});
	});
});

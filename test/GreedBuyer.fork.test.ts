import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { GreedBuyer, TokenPay } from '../typechain-types';
import { BASE } from '../scripts/lib/mainnet';

// Live Aerodrome Slipstream pools on Base mainnet, pinned at FORK_BLOCK. A real stock-paired GREED doesn't exist yet, so other
// tokens stand in for the stock and for GREED: what's proven here is the route, the callback and the quote on real pools.
const CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
const PKR = '0x42121409238342fba3ab07f56c2d44b9f6bbfd69'; // a live WETH-paired Stonks V2 coin (the poker game)
const PKR_POOL = '0xf7e5416A365704E7B6eDc680538799f2F7CddB9B';
const TICK_SPACINGS = [1, 10, 50, 100, 200, 2000];
const ERC20 = '@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20';
const SPLIT = { costsBps: 1000, potsBps: 5000 };

const suite = process.env.FORK === '1' && process.env.FORK_CHAIN_ID !== '84532' ? describe : describe.skip;

suite('The payment route on live Slipstream pools (mainnet fork)', function () {
	this.timeout(180_000);

	// Hardhat can't run a call at the fork block itself on this chain, so the reads below start one block past it.
	before(async () => {
		await network.provider.send('hardhat_mine', ['0x1']);
	});

	/** The deepest pool for a pair on the factory PKR's pool came from, so the test names no pool it hasn't found on-chain. */
	async function slipstreamPool(tokenA: string, tokenB: string): Promise<string> {
		const pkrPool = new ethers.Contract(PKR_POOL, ['function factory() view returns (address)'], ethers.provider);
		const factory = new ethers.Contract(await pkrPool.factory(), ['function getPool(address, address, int24) view returns (address)'], ethers.provider);
		let deepest = { pool: ethers.ZeroAddress, liquidity: 0n };
		for (const spacing of TICK_SPACINGS) {
			const pool = (await factory.getPool(tokenA, tokenB, spacing)) as string;
			if (pool === ethers.ZeroAddress) continue;
			const liquidity = (await new ethers.Contract(pool, ['function liquidity() view returns (uint128)'], ethers.provider).liquidity()) as bigint;
			if (liquidity > deepest.liquidity) deepest = { pool, liquidity };
		}
		expect(deepest.pool, `no Slipstream pool with liquidity for ${tokenA}/${tokenB}`).to.not.equal(ethers.ZeroAddress);
		return deepest.pool;
	}

	/** GreedBuyer: WETH to cbBTC (standing in for the stock), cbBTC to USDC (standing in for GREED). */
	async function deployBuyer() {
		const [payer, treasury, costs, alice] = await ethers.getSigners();
		const route = {
			payToken: BASE.weth,
			firstPool: await slipstreamPool(BASE.weth, CBBTC),
			secondPool: ethers.ZeroAddress,
			stock: CBBTC,
			stockPool: await slipstreamPool(CBBTC, BASE.usdc),
			greed: BASE.usdc,
			treasury: treasury.address,
			costs: costs.address,
			...SPLIT,
		};
		const buyer = (await ethers.deployContract('GreedBuyer', [route])) as unknown as GreedBuyer;
		return { payer, treasury, costs, alice, buyer, stock: await ethers.getContractAt(ERC20, CBBTC), greed: await ethers.getContractAt(ERC20, BASE.usdc), weth: await ethers.getContractAt(ERC20, BASE.weth) };
	}

	it('quotePay matches what pay buys, and the split lands on live pools', async () => {
		const { treasury, costs, buyer, stock, greed, weth } = await deployBuyer();
		const ethIn = 10n ** 16n;
		const quoted = await buyer.quotePay.staticCall(ethIn);
		expect(quoted).to.be.greaterThan(0n);
		await expect(buyer.pay(ethers.id('fork-1'), (quoted * 97n) / 100n, { value: ethIn })).to.emit(buyer, 'Paid');
		expect(await greed.balanceOf(treasury.address)).to.equal(quoted);
		expect(await stock.balanceOf(treasury.address)).to.be.greaterThan(0n);
		expect(await weth.balanceOf(costs.address)).to.equal(ethIn / 10n);
		const at = await buyer.getAddress();
		for (const token of [stock, greed, weth]) expect(await token.balanceOf(at)).to.equal(0n);
		expect(await ethers.provider.getBalance(at)).to.equal(0n);
	});

	it('pay reverts Slippage on live pools when the floor is too high', async () => {
		const { buyer } = await deployBuyer();
		await expect(buyer.pay(ethers.id('fork-2'), 2n ** 255n, { value: 10n ** 16n })).to.be.revertedWithCustomError(buyer, 'Slippage');
	});

	it('quoteBuy matches what buy delivers to the given wallet', async () => {
		const { alice, buyer, greed } = await deployBuyer();
		const quoted = await buyer.quoteBuy.staticCall(10n ** 16n);
		await buyer.buy(alice.address, (quoted * 97n) / 100n, { value: 10n ** 16n });
		expect(await greed.balanceOf(alice.address)).to.equal(quoted);
	});

	it('TokenPay takes USDC through WETH (standing in for the stock) to a real Stonks coin (standing in for GREED)', async () => {
		const { alice, treasury, costs, buyer } = await deployBuyer();
		await buyer.buy(alice.address, 1n, { value: 10n ** 16n });
		const usdc = await ethers.getContractAt(ERC20, BASE.usdc);
		const usdcIn = 2_000_000n;
		const route = {
			payToken: BASE.usdc,
			firstPool: await slipstreamPool(BASE.usdc, BASE.weth),
			secondPool: ethers.ZeroAddress,
			stock: BASE.weth,
			stockPool: PKR_POOL,
			greed: PKR,
			treasury: treasury.address,
			costs: costs.address,
			...SPLIT,
		};
		const pay = (await ethers.deployContract('TokenPay', [route])) as unknown as TokenPay;
		await usdc.connect(alice).getFunction('approve')(await pay.getAddress(), usdcIn);
		const quoted = await pay.quotePay.staticCall(usdcIn);
		const pkr = await ethers.getContractAt(ERC20, PKR);
		const weth = await ethers.getContractAt(ERC20, BASE.weth);
		const [costsBefore, wethBefore, pkrBefore] = [await usdc.balanceOf(costs.address), await weth.balanceOf(treasury.address), await pkr.balanceOf(treasury.address)];
		await pay.connect(alice).payUsdc(ethers.id('fork-usdc'), usdcIn, (quoted * 97n) / 100n);
		expect((await pkr.balanceOf(treasury.address)) - pkrBefore).to.equal(quoted);
		expect((await usdc.balanceOf(costs.address)) - costsBefore).to.equal(usdcIn / 10n);
		expect((await weth.balanceOf(treasury.address)) - wethBefore).to.be.greaterThan(0n);
	});
});

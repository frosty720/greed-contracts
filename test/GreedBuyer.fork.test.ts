import { expect } from 'chai';
import { ethers } from 'hardhat';
import { GreedBuyer } from '../typechain-types';

// A live WETH-paired Stonks V2 coin (the poker game) on Base mainnet, pinned at FORK_BLOCK.
const WETH = '0x4200000000000000000000000000000000000006';
const PKR = '0x42121409238342fba3ab07f56c2d44b9f6bbfd69';
const PKR_POOL = '0xf7e5416A365704E7B6eDc680538799f2F7CddB9B';
const ERC20 = '@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20';

const suite = process.env.FORK === '1' ? describe : describe.skip;

suite('GreedBuyer on a live Slipstream pool (mainnet fork)', function () {
	this.timeout(180_000);

	async function deploy() {
		const [payer, treasury, alice] = await ethers.getSigners();
		const buyer = (await ethers.deployContract('GreedBuyer', [WETH, PKR, PKR_POOL, treasury.address])) as unknown as GreedBuyer;
		const pkr = await ethers.getContractAt(ERC20, PKR);
		const weth = await ethers.getContractAt(ERC20, WETH);
		return { payer, treasury, alice, buyer, pkr, weth };
	}

	async function eventArg(buyer: GreedBuyer, txPromise: Promise<{ wait: () => Promise<unknown> }>, name: 'Paid' | 'Bought'): Promise<bigint> {
		const receipt = (await (await txPromise).wait()) as { logs: { topics: string[]; data: string }[] };
		for (const log of receipt.logs) {
			const parsed = buyer.interface.parseLog(log);
			if (parsed?.name === name) return parsed.args.greedOut as bigint;
		}
		throw new Error(`${name} not emitted`);
	}

	it('pay buys PKR on the live Slipstream pool for the treasury', async () => {
		const { treasury, buyer, pkr, weth } = await deploy();
		const greedOut = await eventArg(buyer, buyer.pay(ethers.id('fork-1'), 1n, { value: 10n ** 16n }), 'Paid');
		expect(greedOut).to.be.greaterThan(0n);
		expect(await pkr.balanceOf(treasury.address)).to.equal(greedOut);
		const at = await buyer.getAddress();
		expect(await ethers.provider.getBalance(at)).to.equal(0n);
		expect(await weth.balanceOf(at)).to.equal(0n);
	});

	it('pay reverts Slippage on the live pool when the floor is too high', async () => {
		const { buyer } = await deploy();
		await expect(buyer.pay(ethers.id('fork-2'), 2n ** 255n, { value: 10n ** 16n })).to.be.revertedWithCustomError(buyer, 'Slippage');
	});

	it('buy delivers PKR to the given wallet on the live pool', async () => {
		const { alice, buyer, pkr } = await deploy();
		const greedOut = await eventArg(buyer, buyer.buy(alice.address, 1n, { value: 10n ** 16n }), 'Bought');
		expect(greedOut).to.be.greaterThan(0n);
		expect(await pkr.balanceOf(alice.address)).to.equal(greedOut);
	});
});

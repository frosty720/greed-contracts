import { expect } from 'chai';
import { Interface } from 'ethers';
import { ethers } from 'hardhat';

describe('MockGreed', () => {
	it('mints exactly 1B tGREED to the deployer and has no mint', async () => {
		const [deployer] = await ethers.getSigners();
		const greed = await ethers.deployContract('MockGreed');
		const supply = 1_000_000_000n * 10n ** 18n;
		expect(await greed.totalSupply()).to.equal(supply);
		expect(await greed.balanceOf(deployer.address)).to.equal(supply);
		expect(await greed.name()).to.equal('Greed is Good (Test)');
		expect(await greed.symbol()).to.equal('tGREED');
		expect(await greed.decimals()).to.equal(18n);
		const abi: Interface = greed.interface;
		expect(abi.getFunction('mint')).to.equal(null);
	});
});

describe('MockUSDC', () => {
	it('has 6 decimals like real USDC, starts empty, and lets any test wallet mint', async () => {
		const [, alice] = await ethers.getSigners();
		const usdc = await ethers.deployContract('MockUSDC');
		expect(await usdc.decimals()).to.equal(6n);
		expect(await usdc.symbol()).to.equal('tUSDC');
		expect(await usdc.totalSupply()).to.equal(0n);
		await usdc.connect(alice).mint(alice.address, 5_000_000n);
		expect(await usdc.balanceOf(alice.address)).to.equal(5_000_000n);
	});

	it('mints at most 10,000 tUSDC a call, so nobody can mint a payment big enough to overflow the game', async () => {
		const [, alice] = await ethers.getSigners();
		const usdc = await ethers.deployContract('MockUSDC');
		await usdc.connect(alice).mint(alice.address, 10_000n * 10n ** 6n);
		await expect(usdc.connect(alice).mint(alice.address, 10_000n * 10n ** 6n + 1n)).to.be.revertedWithCustomError(usdc, 'MintTooBig');
		expect(await usdc.balanceOf(alice.address)).to.equal(10_000n * 10n ** 6n);
	});
});

describe('MockStock', () => {
	async function deploy() {
		const [owner, alice] = await ethers.getSigners();
		const stock = await ethers.deployContract('MockStock', ['Mock Stock Alpha', 'MSKA', owner.address]);
		return { stock, owner, alice };
	}

	it('uses 8 decimals like the real stock tokens', async () => {
		const { stock } = await deploy();
		expect(await stock.decimals()).to.equal(8n);
		expect(await stock.symbol()).to.equal('MSKA');
	});

	it('lets only the owner mint', async () => {
		const { stock, alice } = await deploy();
		await stock.mint(alice.address, 500_000_000n);
		expect(await stock.balanceOf(alice.address)).to.equal(500_000_000n);
		await expect(stock.connect(alice).mint(alice.address, 1n))
			.to.be.revertedWithCustomError(stock, 'OwnableUnauthorizedAccount')
			.withArgs(alice.address);
	});
});

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

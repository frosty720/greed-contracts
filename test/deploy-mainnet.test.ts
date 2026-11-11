import { expect } from 'chai';
import path from 'path';
import { ethers, network } from 'hardhat';
import { BASE, deployPrizePool, requireBase, requireSafe, withoutUrls } from '../scripts/lib/mainnet';
import { CLAIM_WINDOW, deploymentFile } from '../scripts/lib/sepolia';

const rejection = async (promise: Promise<unknown>): Promise<string> => {
	try {
		await promise;
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error('expected a rejection');
};

describe('mainnet deploy checks', () => {
	describe('requireBase', () => {
		it('accepts Base', () => {
			expect(() => requireBase(BASE.chainId)).not.to.throw();
		});

		it('refuses Base Sepolia, so a test run can never write the mainnet file', () => {
			expect(() => requireBase(84532n)).to.throw('not Base (8453)');
		});

		it('refuses any other chain', () => {
			expect(() => requireBase(1n)).to.throw('not Base (8453)');
		});
	});

	describe('requireSafe', () => {
		it('refuses something that is not an address', async () => {
			expect(await rejection(requireSafe(ethers.provider, 'nope'))).to.contain('not an address');
		});

		it('refuses a plain wallet, which would leave prize rounds resting on one key', async () => {
			const [wallet] = await ethers.getSigners();
			expect(await rejection(requireSafe(ethers.provider, wallet.address))).to.contain('has no contract');
		});

		it('refuses a contract that is not a Safe', async () => {
			const token = await ethers.deployContract('MockGreed');
			expect(await rejection(requireSafe(ethers.provider, await token.getAddress()))).to.contain('not a Safe');
		});

		it('reads the owners and threshold of a Safe', async () => {
			const [a, b, c] = await ethers.getSigners();
			const safe = await ethers.deployContract('MockSafe', [[a.address, b.address, c.address], 2]);
			const { threshold, owners } = await requireSafe(ethers.provider, await safe.getAddress());
			expect(threshold).to.equal(2n);
			expect(owners).to.deep.equal([a.address, b.address, c.address]);
		});
	});

	describe('deployPrizePool', () => {
		it('makes the Safe the owner, so the deployer keeps no power over prizes', async () => {
			const [deployer, a] = await ethers.getSigners();
			const safe = await ethers.deployContract('MockSafe', [[a.address], 1]);
			const safeAddress = await safe.getAddress();
			const deployment = await deployPrizePool(deployer, safeAddress);
			const pool = await ethers.getContractAt('PrizePool', deployment.prizePool);
			expect(await pool.owner()).to.equal(safeAddress);
			expect(await pool.owner()).not.to.equal(deployer.address);
		});

		it('records the claim window and the block it was deployed in', async () => {
			const [deployer, a] = await ethers.getSigners();
			const safe = await ethers.deployContract('MockSafe', [[a.address], 1]);
			const safeAddress = await safe.getAddress();
			const deployment = await deployPrizePool(deployer, safeAddress);
			const pool = await ethers.getContractAt('PrizePool', deployment.prizePool);
			expect(await pool.claimWindow()).to.equal(BigInt(CLAIM_WINDOW));
			expect(deployment.claimWindow).to.equal(CLAIM_WINDOW);
			expect(deployment.treasury).to.equal(safeAddress);
			expect(deployment.block).to.equal(await ethers.provider.getBlockNumber());
		});
	});

	describe('deployPrizePool after broadcast', () => {
		it('hands over the transaction and address before waiting, so a dropped connection still leaves a record', async () => {
			const [deployer, a] = await ethers.getSigners();
			const safe = await ethers.deployContract('MockSafe', [[a.address], 1]);
			let receiptAtBroadcast: unknown = 'not called';
			let sent = { txHash: '', prizePool: '' };
			await network.provider.send('evm_setAutomine', [false]);
			try {
				const deployment = await deployPrizePool(deployer, await safe.getAddress(), async (broadcast) => {
					sent = broadcast;
					receiptAtBroadcast = await ethers.provider.getTransactionReceipt(broadcast.txHash);
					await network.provider.send('evm_mine');
				});
				expect(receiptAtBroadcast).to.equal(null);
				expect(sent.prizePool).to.equal(deployment.prizePool);
			} finally {
				await network.provider.send('evm_setAutomine', [true]);
			}
		});
	});

	describe('deploymentFile', () => {
		const fileFor = (network: string): string => path.basename(deploymentFile(network));

		it('keeps Base and Base Sepolia apart', () => {
			expect(fileFor('base')).to.equal('base.json');
			expect(fileFor('baseSepolia')).to.equal('base-sepolia.json');
		});

		it('sends anything else to the ignored local file', () => {
			expect(fileFor('hardhat')).to.equal('local-fork.json');
		});
	});

	describe('withoutUrls', () => {
		it('hides an RPC address inside an error message', () => {
			const message = withoutUrls('could not reach https://8453.rpc.example.com/abc123 (timeout)');
			expect(message).to.equal('could not reach <rpc-url> (timeout)');
		});
	});
});

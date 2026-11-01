import { expect } from 'chai';
import { getAddress } from 'ethers';
import { buildLeaves } from '../scripts/lib/prize-tree';

const A = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const S1 = getAddress('0x1715f9882c087bda2cef4046b484323eef9f7497');
const S2 = getAddress('0xa542788f7c2f73cca77892aeb1ff04f8b2f43cc9');

describe('prize-tree buildLeaves', () => {
	it('merges a wallet listed twice into one leaf with summed amounts', () => {
		const { leaves, totals } = buildLeaves(1n, [{ account: A, amounts: { [S1]: '10' } }, { account: A, amounts: { [S1]: '5', [S2]: '3' } }], [S1, S2]);
		expect(leaves).to.deep.equal([[1n, A, [S1, S2], [15n, 3n]]]);
		expect([...totals.entries()]).to.deep.equal([[S1, 15n], [S2, 3n]]);
	});

	it('treats different letter case as the same wallet and token', () => {
		const { leaves } = buildLeaves(1n, [{ account: A.toLowerCase(), amounts: { [S1.toLowerCase()]: '1' } }, { account: A, amounts: { [S1]: '2' } }], [S1]);
		expect(leaves).to.deep.equal([[1n, A, [S1], [3n]]]);
	});

	it('drops zero amounts and wallets left with nothing', () => {
		const { leaves, totals } = buildLeaves(1n, [{ account: A, amounts: { [S1]: '0', [S2]: '4' } }, { account: B, amounts: { [S1]: '0' } }], [S1, S2]);
		expect(leaves).to.deep.equal([[1n, A, [S2], [4n]]]);
		expect([...totals.entries()]).to.deep.equal([[S2, 4n]]);
	});

	it('refuses a token outside the deployment', () => {
		expect(() => buildLeaves(1n, [{ account: A, amounts: { [S2]: '1' } }], [S1])).to.throw(/not one of the deployment's stock tokens/);
	});

	it('refuses a negative amount', () => {
		expect(() => buildLeaves(1n, [{ account: A, amounts: { [S1]: '-1' } }], [S1])).to.throw(/negative/);
	});
});

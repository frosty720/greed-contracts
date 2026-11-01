import { expect } from 'chai';
import { priceToSqrtPriceX96, priceToTick, singleSidedRange } from '../scripts/lib/pool-math';

describe('pool-math', () => {
	it('maps price 1 to sqrtPriceX96 2^96 and tick 0', () => {
		expect(priceToSqrtPriceX96(1)).to.equal(2n ** 96n);
		expect(priceToTick(1)).to.equal(0);
	});

	it('maps a launch-sized price to the matching tick', () => {
		// 1.0001^-202694 ≈ 1.6e-9, the order of a $4K launch priced in ETH
		expect(priceToTick(1.0001 ** -202694.5)).to.equal(-202695);
	});

	it('keeps a single-sided GREED range on the right side of the price', () => {
		expect(singleSidedRange(-12345, true, 200)).to.deep.equal({ tickLower: -12200, tickUpper: 887200 });
		expect(singleSidedRange(-12345, false, 200)).to.deep.equal({ tickLower: -887200, tickUpper: -12400 });
		expect(singleSidedRange(-12400, true, 200)).to.deep.equal({ tickLower: -12200, tickUpper: 887200 });
	});
});

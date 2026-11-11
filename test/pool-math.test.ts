import { expect } from 'chai';
import { oneWayPoolPrice, priceToSqrtPriceX96, priceToTick, singleSidedRange, usdPerGreedFromEthPool } from '../scripts/lib/pool-math';

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

	it('prices a pool in raw units as token1 per token0, whichever side the token it sells sits on', () => {
		// $4e-6 a GREED: 4e-6 USDC is 4 raw units for 1e18 raw GREED.
		expect(oneWayPoolPrice(4e-6, 18, 6, true)).to.be.closeTo(4e-18, 1e-24);
		expect(oneWayPoolPrice(4e-6, 18, 6, false)).to.be.closeTo(2.5e17, 1e11);
		// $2,000 ETH: one raw USDC (1e-6 of a dollar) costs 5e8 raw WETH.
		expect(oneWayPoolPrice(1 / 2_000, 6, 18, true)).to.be.closeTo(5e8, 1);
		expect(oneWayPoolPrice(1 / 2_000, 6, 18, false)).to.be.closeTo(2e-9, 1e-15);
	});

	it('reads a dollar price for GREED from a GREED/WETH pool, whichever side GREED sits on', () => {
		// A price of 1e-9 WETH a GREED at $2,000 ETH is $2e-6 a GREED.
		const sqrtToken0 = BigInt(Math.floor(Math.sqrt(1e-9) * 2 ** 96));
		expect(usdPerGreedFromEthPool(sqrtToken0, true, 2_000)).to.be.closeTo(2e-6, 1e-12);
		const sqrtToken1 = BigInt(Math.floor(Math.sqrt(1e9) * 2 ** 96));
		expect(usdPerGreedFromEthPool(sqrtToken1, false, 2_000)).to.be.closeTo(2e-6, 1e-12);
	});
});

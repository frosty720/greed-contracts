/** Uniswap-v3 price helpers for seeding a single-sided pool, like a Stonks launch. Prices are token1 per token0. */

const Q96 = 2 ** 96;
const MAX_TICK = 887272;

export function priceToSqrtPriceX96(token1PerToken0: number): bigint {
	return BigInt(Math.floor(Math.sqrt(token1PerToken0) * Q96));
}

export function priceToTick(token1PerToken0: number): number {
	return Math.floor(Math.log(token1PerToken0) / Math.log(1.0001));
}

/**
 * A range that holds only GREED at the current price. Token0 sits above the price (and a position is in range when
 * tick == tickLower, so the lower tick is strictly above); token1 sits at or below it.
 */
export function singleSidedRange(currentTick: number, greedIsToken0: boolean, tickSpacing: number): { tickLower: number; tickUpper: number } {
	const maxUsable = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
	const below = Math.floor(currentTick / tickSpacing) * tickSpacing;
	return greedIsToken0 ? { tickLower: below + tickSpacing, tickUpper: maxUsable } : { tickLower: -maxUsable, tickUpper: below };
}

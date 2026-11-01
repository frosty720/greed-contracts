import { getAddress } from 'ethers';

/** A winners file row: one wallet and what it won, in each stock token's smallest units. */
export type Winner = { account: string; amounts: Record<string, string> };
/** A PrizePool leaf: one per wallet per round, holding every token that wallet won. */
export type Leaf = [roundId: bigint, account: string, tokens: string[], amounts: bigint[]];
export const LEAF_TYPES = ['uint256', 'address', 'address[]', 'uint256[]'];

/**
 * PrizePool pays each wallet once per round, so a wallet that won several prizes in one run must be one leaf:
 * rows for the same wallet merge (summed per token), zero amounts drop out, and tokens outside the deployment are refused.
 */
export function buildLeaves(roundId: bigint, winners: Winner[], knownTokens: string[]): { leaves: Leaf[]; totals: Map<string, bigint> } {
	const known = new Set(knownTokens.map((t) => getAddress(t)));
	const byWallet = new Map<string, Map<string, bigint>>();
	for (const w of winners) {
		const account = getAddress(w.account);
		const won = byWallet.get(account) ?? new Map<string, bigint>();
		for (const [rawToken, rawAmount] of Object.entries(w.amounts)) {
			const token = getAddress(rawToken);
			if (!known.has(token)) throw new Error(`${token} is not one of the deployment's stock tokens`);
			const amount = BigInt(rawAmount);
			if (amount < 0n) throw new Error(`negative amount ${rawAmount} for ${account}`);
			won.set(token, (won.get(token) ?? 0n) + amount);
		}
		byWallet.set(account, won);
	}
	const leaves: Leaf[] = [];
	const totals = new Map<string, bigint>();
	for (const [account, won] of byWallet) {
		const paid = [...won.entries()].filter(([, amount]) => amount > 0n);
		if (paid.length === 0) continue;
		leaves.push([roundId, account, paid.map(([t]) => t), paid.map(([, a]) => a)]);
		for (const [t, a] of paid) totals.set(t, (totals.get(t) ?? 0n) + a);
	}
	return { leaves, totals };
}

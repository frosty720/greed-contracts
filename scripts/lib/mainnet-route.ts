import { Signer, getAddress, isAddress, Interface, Contract, Provider, ZeroAddress, toBeHex } from 'ethers';
import { artifacts, ethers } from 'hardhat';
import { BASE, withoutUrls } from './mainnet';
import { SPLIT } from './token-pay';

/**
 * GREED's payment route on Base: every address read on-chain on 2026-11-16 (GREED launched paired with GMEc, 2026-11-16).
 * GMEc is a B20 token, which the Base node runs natively: a local fork cannot execute it, so the route is checked by
 * simulating on the live chain (`simulateRoute`), never on a fork.
 */
export const BASE_ROUTE = {
	/** GameStop's tokenized share on Base, 8 decimals. */
	gme: '0xb2000000000000000000007790ed6E48e06eD935',
	/** Stonks Exchange USDC/GMEc, tick spacing 1, fee 0.01%: the deepest GMEc pool against USDC (about $537 on 2026-11-16). */
	gmeUsdcPool: '0xbBe3491582DD226bB35C6bC14AfB825941390f45',
	/** Aerodrome WETH/USDC, tick spacing 100. ETH goes through USDC: GMEc has no WETH pool worth using. */
	wethUsdcPool: '0x2A430bEbD2082d8e05D56d64DEDE8944279bbC24',
	/** The factory Stonks Exchange's launcher opens its coins' pools on. */
	stonksFactory: '0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef',
} as const;

/** StockRoute's constructor argument. */
export interface Route {
	payToken: string;
	firstPool: string;
	secondPool: string;
	stock: string;
	stockPool: string;
	greed: string;
	treasury: string;
	costs: string;
	costsBps: number;
	potsBps: number;
}

export interface PayRoutes {
	/** ETH: WETH to USDC, USDC to the stock, the stock to GREED. */
	buyer: Route;
	/** USDC: straight to the stock, then GREED. */
	tokenPay: Route;
}

export interface RouteEnds {
	greed: string;
	/** GREED's own pool against the stock, made by the launchpad. */
	greedPool: string;
	treasury: string;
	costs: string;
}

/** The pools a payment walks, when they aren't Base's own. A test builds its route from mocks with these. */
export interface RouteLegs {
	weth: string;
	usdc: string;
	stock: string;
	wethUsdcPool: string;
	stockUsdcPool: string;
}

const BASE_LEGS: RouteLegs = { weth: BASE.weth, usdc: BASE.usdc, stock: BASE_ROUTE.gme, wethUsdcPool: BASE_ROUTE.wethUsdcPool, stockUsdcPool: BASE_ROUTE.gmeUsdcPool };

/** Both contracts' routes for GREED paired with the stock. Players pay in ETH or USDC and never hold the stock. */
export function payRoutes(ends: RouteEnds, legs: RouteLegs = BASE_LEGS): PayRoutes {
	for (const [name, address] of Object.entries(ends)) if (!isAddress(address) || address === ZeroAddress) throw new Error(`${name} must be an address`);
	const shared = { stock: legs.stock, stockPool: getAddress(ends.greedPool), greed: getAddress(ends.greed), treasury: getAddress(ends.treasury), costs: getAddress(ends.costs), ...SPLIT };
	return {
		buyer: { ...shared, payToken: legs.weth, firstPool: legs.wethUsdcPool, secondPool: legs.stockUsdcPool },
		tokenPay: { ...shared, payToken: legs.usdc, firstPool: legs.stockUsdcPool, secondPool: ZeroAddress },
	};
}

const POOL_ABI = ['function token0() view returns (address)', 'function token1() view returns (address)', 'function factory() view returns (address)', 'function tickSpacing() view returns (int24)', 'function liquidity() view returns (uint128)'];
/** The launchpad factory's own record of its pools, read on Base on 2026-11-11: either token order answers. */
const FACTORY_ABI = ['function getPool(address, address, int24) view returns (address)'];

/**
 * GREED's pool must be the launchpad's pool of GREED against the stock, with liquidity in it. Deploying against any other
 * pool would be permanent: neither contract's route can change. The factory itself must list the pool: a look-alike can
 * claim any factory, so the pool's own word is not enough.
 */
export async function requireGreedPool(provider: Provider, pool: string, greed: string, stock: string = BASE_ROUTE.gme, factory: string = BASE_ROUTE.stonksFactory): Promise<{ liquidity: bigint }> {
	if (!isAddress(pool) || !isAddress(greed)) throw new Error('GREED_ADDRESS and GREED_POOL must be addresses');
	if ((await provider.getCode(pool)) === '0x') throw new Error(`${pool} has no contract on this chain, so it can't be GREED's pool`);
	const contract = new Contract(pool, POOL_ABI, provider);
	let tokens: string[];
	let madeBy: string;
	let spacing: bigint;
	let liquidity: bigint;
	try {
		tokens = [(await contract.token0()) as string, (await contract.token1()) as string].map((t) => t.toLowerCase());
		madeBy = (await contract.factory()) as string;
		spacing = (await contract.tickSpacing()) as bigint;
		liquidity = (await contract.liquidity()) as bigint;
	} catch (error) {
		throw new Error(`${pool} is not a pool the route can swap on, or the RPC failed: ${withoutUrls((error as Error).message)}`);
	}
	const wanted = [greed.toLowerCase(), stock.toLowerCase()];
	if (!wanted.every((t) => tokens.includes(t)) || greed.toLowerCase() === stock.toLowerCase()) throw new Error(`${pool} does not trade GREED (${greed}) against the stock (${stock})`);
	if (madeBy.toLowerCase() !== factory.toLowerCase()) throw new Error(`${pool} was made by ${madeBy}, not the launchpad's factory ${factory}`);
	let listed: string;
	try {
		listed = (await new Contract(factory, FACTORY_ABI, provider).getPool(greed, stock, spacing)) as string;
	} catch (error) {
		throw new Error(`the launchpad's factory ${factory} could not be asked about ${pool}: ${withoutUrls((error as Error).message)}`);
	}
	if (listed.toLowerCase() !== pool.toLowerCase()) throw new Error(`the launchpad's factory ${factory} does not list ${pool} as its pool of GREED against the stock`);
	if (liquidity === 0n) throw new Error(`${pool} has no liquidity in range: a payment could not buy GREED on it`);
	return { liquidity };
}

type Rpc = { send(method: string, params: unknown[]): Promise<unknown> };

export interface SimulatedSize {
	amountIn: bigint;
	/** What a game payment of this size buys for the treasury, and what a Shop buy gets: the contracts' own quotes. */
	quotePay: bigint;
	quoteBuy: bigint;
	/**
	 * What `pay` and `buy` return when run in full, tokens moving, on live state. For USDC, `pay` runs only when a holder is
	 * named (it needs USDC and an allowance) and `buy` is never run.
	 */
	pay: bigint | null;
	buy: bigint | null;
}

const SIM_AT = '0x00000000000000000000000000000000005150f1';
const SIM_PAYER = '0x00000000000000000000000000000000000ba1e5';
const PAY_ABI = new Interface([
	'function quotePay(uint256) returns (uint256)',
	'function quoteBuy(uint256) returns (uint256)',
	'function pay(bytes32, uint256) payable returns (uint256)',
	'function buy(address, uint256) payable returns (uint256)',
]);
const SIM_PAYER_ABI = new Interface(['function payUsdc(address usdc, address tokenPay, uint256 amount) returns (uint256)']);

/**
 * Runs a payment contract against the chain's current state without deploying or sending anything: the node runs the
 * constructor for the route, then each call against that code at a scratch address. This is the only way to exercise a
 * B20 stock, and it fails exactly where a real payment would (a pool that isn't one, a token that won't transfer).
 * `usdcHolder` is any address that holds at least the largest size in USDC and is not on the route: for the length of
 * one call it runs SimPayer's code, so a USDC payment is made in full from its balance.
 */
export async function simulateRoute(provider: Rpc, contract: 'GreedBuyer' | 'TokenPay', route: Route, sizes: bigint[], usdcHolder?: string): Promise<SimulatedSize[]> {
	const factory = await ethers.getContractFactory(contract);
	const creation = (await factory.getDeployTransaction(route)).data;
	const step = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
		try {
			return await run();
		} catch (error) {
			throw new Error(`${contract}: ${what} failed: ${withoutUrls((error as Error).message)}`);
		}
	};
	const code = await step('its constructor refused the route', () => provider.send('eth_call', [{ data: creation }, 'latest']) as Promise<string>);
	const call = async (fn: 'quotePay' | 'quoteBuy' | 'pay' | 'buy', args: unknown[], value = 0n): Promise<bigint> => {
		const tx = { from: SIM_PAYER, to: SIM_AT, data: PAY_ABI.encodeFunctionData(fn, args), value: toBeHex(value) };
		const overrides = { [SIM_AT]: { code }, [SIM_PAYER]: { balance: toBeHex(value * 2n + 10n ** 18n) } };
		const result = await step(`${fn} of ${value > 0n ? value : args[0]}`, () => provider.send('eth_call', [tx, 'latest', overrides]) as Promise<string>);
		return PAY_ABI.decodeFunctionResult(fn, result)[0] as bigint;
	};
	const payUsdc = async (holder: string, amountIn: bigint): Promise<bigint> => {
		const payerCode = (await artifacts.readArtifact('SimPayer')).deployedBytecode;
		const tx = { from: SIM_PAYER, to: holder, data: SIM_PAYER_ABI.encodeFunctionData('payUsdc', [route.payToken, SIM_AT, amountIn]) };
		const overrides = { [SIM_AT]: { code }, [holder]: { code: payerCode }, [SIM_PAYER]: { balance: toBeHex(10n ** 18n) } };
		const result = await step(`payUsdc of ${amountIn}`, () => provider.send('eth_call', [tx, 'latest', overrides]) as Promise<string>);
		return SIM_PAYER_ABI.decodeFunctionResult('payUsdc', result)[0] as bigint;
	};
	const out: SimulatedSize[] = [];
	for (const amountIn of sizes) {
		const quotePay = await call('quotePay', [amountIn]);
		const quoteBuy = await call('quoteBuy', [amountIn]);
		const eth = contract === 'GreedBuyer';
		out.push({
			amountIn,
			quotePay,
			quoteBuy,
			pay: eth ? await call('pay', [ethers.id('simulated'), 0n], amountIn) : usdcHolder ? await payUsdc(usdcHolder, amountIn) : null,
			buy: eth ? await call('buy', [route.treasury, 0n], amountIn) : null,
		});
	}
	return out;
}

/** How much less GREED per unit paid the largest size gets than the smallest, in percent: the route's price impact across the sizes. */
export function slippagePercent(sizes: SimulatedSize[]): number {
	if (sizes.length < 2) return 0;
	const rate = (s: SimulatedSize) => Number((s.quoteBuy * 10n ** 18n) / s.amountIn);
	const first = rate(sizes[0]);
	return first === 0 ? 0 : (1 - rate(sizes[sizes.length - 1]) / first) * 100;
}

/** A simulation proves the route only if every size bought GREED. */
export function requireBought(contract: string, sizes: SimulatedSize[]): void {
	for (const s of sizes) {
		const outs = [s.quotePay, s.quoteBuy, ...(s.pay === null ? [] : [s.pay]), ...(s.buy === null ? [] : [s.buy])];
		if (outs.some((o) => o === 0n)) throw new Error(`${contract}: a payment of ${s.amountIn} bought no GREED`);
	}
}

export interface PayBroadcast {
	contract: 'GreedBuyer' | 'TokenPay';
	txHash: string;
	address: string;
}

export interface PayDeployment {
	buyer: string;
	tokenPay: string;
	block: number;
}

/**
 * Deploys GreedBuyer, then TokenPay. Neither has an owner or a way to change its route, so the checks all come first.
 * `onBroadcast` runs as each transaction is sent, before waiting for it, so a dropped connection still leaves a record.
 */
export async function deployPayContracts(deployer: Signer, routes: PayRoutes, onBroadcast: (sent: PayBroadcast) => void | Promise<void> = () => undefined): Promise<PayDeployment> {
	const send = async (contract: 'GreedBuyer' | 'TokenPay', route: Route): Promise<{ address: string; block: number }> => {
		const deployed = await ethers.deployContract(contract, [route], deployer);
		const tx = deployed.deploymentTransaction();
		if (!tx) throw new Error(`${contract} deploy returned no transaction`);
		const address = await deployed.getAddress();
		await onBroadcast({ contract, txHash: tx.hash, address });
		const receipt = await tx.wait();
		if (!receipt) throw new Error(`${contract} deployed but its receipt is missing`);
		return { address, block: receipt.blockNumber };
	};
	const buyer = await send('GreedBuyer', routes.buyer);
	const tokenPay = await send('TokenPay', routes.tokenPay);
	return { buyer: buyer.address, tokenPay: tokenPay.address, block: tokenPay.block };
}

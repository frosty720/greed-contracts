import 'dotenv/config';
import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';

const secret = process.env.THIRDWEB_SECRET_KEY ?? '';
const baseUrl = process.env.BASE_RPC_URL ?? '';
const sepoliaUrl = process.env.BASE_SEPOLIA_RPC_URL ?? '';
const deployer = process.env.DEPLOYER_PRIVATE_KEY;

/**
 * The thirdweb secret goes only to thirdweb's RPC hosts, and only with a client-ID URL (https://<chain>.rpc.thirdweb.com/<clientId>).
 * The bare public endpoint answers without it and rejects it with 401.
 */
function headersFor(url: string): Record<string, string> {
	try {
		const { hostname, pathname } = new URL(url);
		const hasClientId = pathname.split('/').some((part) => part.length > 0);
		return secret && hasClientId && hostname.endsWith('.rpc.thirdweb.com') ? { 'x-secret-key': secret } : {};
	} catch {
		return {};
	}
}

const config: HardhatUserConfig = {
	solidity: {
		version: '0.8.28',
		settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun' },
	},
	networks: {
		hardhat: {
			hardfork: 'cancun',
			// A fork can present its source chain's id, so scripts that check the chain can dry-run against it.
			chainId: Number(process.env.FORK_CHAIN_ID ?? 31337),
			chains: { 8453: { hardforkHistory: { cancun: 0 } }, 84532: { hardforkHistory: { cancun: 0 } } },
			...(process.env.FORK === '1'
				? { forking: { url: baseUrl, blockNumber: Number(process.env.FORK_BLOCK ?? 53139000), httpHeaders: headersFor(baseUrl) } }
				: {}),
		},
		baseSepolia: {
			url: sepoliaUrl,
			chainId: 84532,
			accounts: deployer ? [deployer] : [],
			httpHeaders: headersFor(sepoliaUrl),
		},
	},
};

export default config;

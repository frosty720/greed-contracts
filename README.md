# GREED contracts

The on-chain side of [StonkStreet](https://stonkstreet.exchange), a multiplayer stock market game on Base. Players pay for game actions in ETH, USDC or GREED; these contracts turn each payment into GREED and stock for the treasury and the weekly prize pots, and pay out prizes.

## Deployed on Base mainnet

| Contract | Address | What it does |
|---|---|---|
| GreedBuyer | [`0x4190431F7ff95CB5AC8d2Ce4e3F5fdcECCbB848A`](https://basescan.org/address/0x4190431F7ff95CB5AC8d2Ce4e3F5fdcECCbB848A) | Takes ETH payments and Shop buys: WETH → USDC → GMEc → GREED |
| TokenPay | [`0xCd820032D86dDc88951Ef164e5f8130F1371fAfC`](https://basescan.org/address/0xCd820032D86dDc88951Ef164e5f8130F1371fAfC) | Takes USDC payments and Shop buys: USDC → GMEc → GREED, and GREED payments |
| PrizePool | [`0x96FAB57459251f0621d5d5e934c4902E1dB077F8`](https://basescan.org/address/0x96FAB57459251f0621d5d5e934c4902E1dB077F8) | Holds each round's prizes for winners to claim, 28-day claim window, owned by the treasury Safe |

- **GREED:** [`0xcbbaf485817b174a01e29b012e6e85435765d0a7`](https://basescan.org/token/0xcbbaf485817b174a01e29b012e6e85435765d0a7), launched on [Stonks Exchange](https://www.thestonks.exchange/token/0xcbbaf485817b174a01e29b012e6e85435765d0a7) and paired with GMEc (GameStop's tokenized stock on Base) in pool [`0x6E9D3D023333F713671aDEF499Aa3c9f7c0B227d`](https://basescan.org/address/0x6E9D3D023333F713671aDEF499Aa3c9f7c0B227d).
- **Treasury Safe:** [`0x47b7702a4789912d0dfFDadC07c50395c293fF0A`](https://basescan.org/address/0x47b7702a4789912d0dfFDadC07c50395c293fF0A).
- Every address above is also in [`deployments/base.json`](deployments/base.json).

## Where a payment goes

An ETH or USDC payment for a game action is split by the contract itself: 10% to running costs in the token paid, 50% bought into GMEc for the prize pots, and 40% bought into GREED for the treasury. A GREED payment goes straight to the treasury. Neither payment contract has an owner, and their routes and split can't be changed after deployment.

## Build and test

```bash
npm install
npx hardhat test
```

## Scripts

| Script | What it does |
|---|---|
| `scripts/check-route.ts` | Simulates both payment contracts against live Base state; sends nothing |
| `scripts/deploy-mainnet-pay.ts` | Deploys GreedBuyer and TokenPay; a dry run unless `DEPLOY=1` |
| `scripts/deploy-mainnet.ts` | Deploys PrizePool; a dry run unless `DEPLOY=1` |
| `scripts/verify-mainnet.ts` | Publishes the three contracts' source on BaseScan (needs `ETHERSCAN_API_KEY`) |

Settings go in `.env`; see [`.env.example`](.env.example).

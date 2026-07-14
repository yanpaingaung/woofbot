# Base Analytics Plugin

> [!IMPORTANT]
> ## STOP — COMPLETE ONBOARDING BEFORE USING THIS PLUGIN
>
> Before calling any Base Analytics endpoint, you MUST complete the Base MCP onboarding flow:
> 1. Call `get_wallets` (Detection) to confirm the user's wallet address
> 2. Present wallet status and the standard disclaimer
>
> The user's wallet address is required if you plan to look up their holdings alongside analytics data.

Base Analytics is a **read-only** analytics server for Base chain. It provides Uniswap V4 pool data, token holder statistics, and contract deployer history — data that Base MCP's core tools do not cover. There are **no transactions to sign**: this plugin has no `send_calls` mapping.

**Base chain only.** All endpoints query Base mainnet exclusively.

**Fetching data:** this server is not on the Base MCP `web_request` allowlist by default. Use `web_request` if your host has it allowlisted; otherwise call the endpoints directly through whatever HTTP capability the harness exposes, or ask the user to paste the JSON response into the chat.

---

## Read endpoints

Base URL: `https://<your-deployed-url>` (or `http://localhost:8788` for local dev)

All endpoints return JSON. All addresses are checksummed or lowercased hex strings starting with `0x`.

---

### Token holder count

```
GET /api/holder-count/{tokenAddress}
```

Returns total holder count and basic token info (name, symbol, total supply) from BaseScan's free-tier `tokeninfo` endpoint.

**Example response:**
```json
{
  "tokenAddress": "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b",
  "holderCount": "142857",
  "tokenName": "Virtual Protocol",
  "symbol": "VIRTUAL",
  "totalSupply": "1000000000000000000000000000",
  "divisor": "18",
  "source": "tokeninfo"
}
```

---

### Top token holders

```
GET /api/holders/{tokenAddress}?limit=10
```

Returns the top `limit` holders (max 100). **Requires a BaseScan Pro API key** on the server — if the server's key is free-tier, the response will include an `error` field with a manual lookup link.

**Example response:**
```json
{
  "tokenAddress": "0x...",
  "holderCount": 10,
  "holders": [
    { "address": "0x...", "balance": "500000000000000000000", "percentOfQueried": "25.0000%" }
  ],
  "note": "Percentage is relative to the top holders queried, not total supply."
}
```

---

### Contract deployer history

```
GET /api/deployer/{contractAddress}
```

Returns the wallet that deployed the contract and every other contract that same wallet has deployed (up to 200 transactions scanned).

**Example response:**
```json
{
  "contractAddress": "0x...",
  "deployer": "0x...",
  "creationTxHash": "0x...",
  "otherContractsDeployed": [
    {
      "contractAddress": "0x...",
      "txHash": "0x...",
      "blockNumber": "12345678",
      "timestamp": "2024-01-15T10:30:00.000Z"
    }
  ]
}
```

---

### Uniswap V4 pools for a token

```
GET /api/pools/{tokenAddress}?fromBlock=0
```

Searches Uniswap V4 PoolManager `Initialize` events on Base for pools where the token is `currency0` or `currency1`. Queries the last 200K blocks by default (~5.5 days); pass `fromBlock` to widen or narrow the search.

**Example response:**
```json
{
  "token": "0x...",
  "poolManagerAddress": "0x498581ff718922c3f8e6a244956af099b2652b2b",
  "searchedBlocks": { "from": 48000000, "to": 48200000 },
  "chunksQueried": 40,
  "poolsFound": 2,
  "pools": [
    {
      "poolId": "0x...",
      "currency0": "0x...",
      "currency1": "0x...",
      "fee": 3000,
      "tickSpacing": 60,
      "hooks": "0x0000000000000000000000000000000000000000",
      "sqrtPriceX96": "...",
      "tick": -12345,
      "blockNumber": 48123456,
      "transactionHash": "0x..."
    }
  ]
}
```

---

### Uniswap V4 pool state

```
GET /api/pool-state/{poolId}
```

Calls StateView's `getSlot0` and `getLiquidity` on-chain for current price and liquidity.

**Example response:**
```json
{
  "poolId": "0x...",
  "stateViewAddress": "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
  "sqrtPriceX96": "79228162514264337593543950336",
  "tick": -276325,
  "protocolFee": 0,
  "lpFee": 3000,
  "liquidity": "1234567890123456789"
}
```

---

### Compute position reserves

```
GET /api/compute-reserves?liquidity=&sqrtPriceX96=&tickLower=&tickUpper=&decimals0=18&decimals1=18
```

Computes `amount0` / `amount1` for a concentrated liquidity position. All inputs are strings/integers. Assumes the current price is in-range.

---

## Orchestration pattern

This plugin is analytics-only — no transactions are produced. Typical flow:

```
1. get_wallets → user's wallet address (for personalised queries)
2. GET /api/holder-count/{token}         → total holders
3. GET /api/holders/{token}?limit=10     → concentration risk (top holders)
4. GET /api/deployer/{token}             → deployer history / rug risk signals
5. GET /api/pools/{token}                → find V4 pool IDs
6. GET /api/pool-state/{poolId}          → live sqrtPrice, tick, liquidity
```

Combine with Base MCP's native tools for a complete picture:
- Use Base MCP `get_token_balance` to check the user's own holding
- Use Base MCP `swap` or `send_calls` if the user then decides to act

## Notes on free-tier limits

| Data | Source | Free tier? |
|------|--------|------------|
| Holder count | BaseScan `tokeninfo` | ✅ Free |
| Pool state (sqrtPrice, tick, liquidity) | On-chain RPC via StateView | ✅ Free |
| Pool discovery (Initialize events) | On-chain RPC via eth_getLogs | ✅ Free (chunked) |
| Deployer lookup | BaseScan `getcontractcreation` | ✅ Free |
| Top holders list | BaseScan `tokenholderlist` | ❌ Pro only |

The server uses on-chain RPC calls (public Base mainnet node) for pool data and the free-tier BaseScan API for contract/holder metadata. A BaseScan Pro key unlocks the top-holders list.

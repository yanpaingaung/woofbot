# base-analytics-mcp

A supplementary read-only MCP server that adds pool analytics and holder data for Base chain, designed to work alongside [Coinbase's public Base MCP](https://mcp.base.org).

## What this server covers

| Tool | Description |
|------|-------------|
| `find_v4_pools` | Search Uniswap V4 PoolManager Initialize events for pools containing a token |
| `get_v4_pool_state` | Get sqrtPriceX96, tick, fees, and liquidity for a V4 pool |
| `compute_v4_reserves` | Compute token0/token1 amounts in a concentrated liquidity position |
| `get_top_holders` | Top N holders of an ERC-20 token (via BaseScan) |
| `get_holder_count` | Total holder count for a token |
| `get_deployer_history` | Contract creator and their other deployments |
| `check_sell_simulation` | Simulate a sell swap via eth_call to detect reverts |

Basic wallet/RPC tools (balances, transfers, ETH price) come from [Coinbase Base MCP](https://mcp.base.org) — this server does not duplicate them.

## Setup

### 1. Get a free BaseScan API key

1. Go to [basescan.org/apis](https://basescan.org/apis)
2. Create a free account
3. Navigate to **API-KEYs** and generate a key
4. The free tier allows 5 req/sec and is sufficient for all tools here

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env and fill in your BASESCAN_API_KEY
```

### 3. Install dependencies

```bash
npm install
```

### 4. Run locally

```bash
npm start
# Server starts on http://localhost:8788
# MCP endpoint: http://localhost:8788/mcp
```

For development with auto-restart:
```bash
npm run dev
```

## Deployment

### Railway

1. Push to a GitHub repo
2. Create a new Railway project → Deploy from GitHub repo
3. Set environment variables: `BASE_RPC_URL`, `BASESCAN_API_KEY`, `PORT`
4. Railway auto-detects Node.js and runs `npm start`
5. Your MCP URL will be `https://your-app.railway.app/mcp`

### Render

1. New Web Service → Connect repo
2. Build command: `npm install`
3. Start command: `npm start`
4. Add environment variables in the Render dashboard
5. Your MCP URL: `https://your-service.onrender.com/mcp`

### Fly.io

```bash
fly launch --name base-analytics-mcp
fly secrets set BASE_RPC_URL=https://mainnet.base.org BASESCAN_API_KEY=your_key
fly deploy
```

## Using both MCP servers together

Add both as connectors in your Claude/MCP client config:

```json
{
  "mcpServers": {
    "base-mcp": {
      "type": "url",
      "url": "https://mcp.base.org"
    },
    "base-analytics-mcp": {
      "type": "url",
      "url": "https://your-deployed-url/mcp"
    }
  }
}
```

For local development:
```json
{
  "mcpServers": {
    "base-mcp": {
      "type": "url",
      "url": "https://mcp.base.org"
    },
    "base-analytics-mcp": {
      "type": "url",
      "url": "http://localhost:8788/mcp"
    }
  }
}
```

## Default contract addresses (Base mainnet)

| Contract | Address |
|----------|---------|
| Uniswap V4 PoolManager | `0x498581ff718922c3f8e6a244956af099b2652b2b` |
| Uniswap V4 StateView | `0xa3c0c9b65bad0b08107aa264b0f3db444b867a71` |

## Health check

```
GET /health
```

Returns `{"status":"ok","server":"base-analytics-mcp","version":"1.0.0"}`.

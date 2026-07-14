# woofbot — Base chain on-chain analyst

Two-part project: a supplementary MCP server for Base analytics, and an X bot that answers on-chain questions about Base chain tokens, pools, and wallets.

```
woofbot/
├── base-analytics-mcp/   ← MCP server (pool analytics + holder data)
└── base-bot/             ← X bot (Claude + two MCP servers)
```

## Quick start

### 1. Start base-analytics-mcp

```bash
cd base-analytics-mcp
npm install
cp .env.example .env      # add BASESCAN_API_KEY
npm start                 # http://localhost:8788/mcp
```

See [base-analytics-mcp/README.md](base-analytics-mcp/README.md) for deployment options (Railway/Render/Fly.io) and getting a free BaseScan API key.

### 2. Run base-bot in dry-run mode

```bash
cd base-bot
npm install
cp .env.example .env      # add ANTHROPIC_API_KEY and BASE_ANALYTICS_MCP_URL
npm start                 # DRY_RUN=true by default
```

### 3. Test the Claude+MCP pipeline without X

```bash
cd base-bot
npm run test-mock         # feeds hardcoded mentions through analyze.js
```

## Architecture

```
User @mentions bot on X
        │
        ▼ (poll every 15 min via twitter-api-v2)
  base-bot/src/bot.js
        │
        ▼ analyzeQuestion()
  Claude claude-sonnet-4-6 (betas: mcp-client-2025-11-20)
        ├─ MCP: mcp.base.org (Coinbase Base MCP)
        │       wallets, balances, ETH price, raw RPC
        └─ MCP: base-analytics-mcp (this repo, port 8788)
                pool analytics, holder data, deployer history
        │
        ▼ ≤260 char reply
  rwClient.v2.reply() — or logged if DRY_RUN=true
```

## MCP tools exposed by base-analytics-mcp

| Tool | What it does |
|------|-------------|
| `find_v4_pools` | Find Uniswap V4 pools containing a token (searches Initialize events) |
| `get_v4_pool_state` | sqrtPriceX96, tick, fees, liquidity for a V4 pool |
| `compute_v4_reserves` | Token amounts in a concentrated liquidity position |
| `get_top_holders` | Top N holders with address, balance, % share |
| `get_holder_count` | Total holder count |
| `get_deployer_history` | Contract deployer + their other deployments |
| `check_sell_simulation` | eth_call simulation of a sell swap (revert detection) |

## What the bot will and won't do

**Will do:**
- Look up holder concentration, pool liquidity, deployer history for any Base token
- Report V4 pool state and simulate sell transactions
- Flag potential impersonator tokens (same name as well-known projects)

**Won't do:**
- Give price predictions or buy/sell advice
- Answer questions about non-Base chains
- Sign transactions or handle private keys (strictly read-only)
# woofbot

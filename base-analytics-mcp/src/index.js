import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import {
  findV4Pools,
  getV4PoolState,
  computeV4Reserves,
  getTopHolders,
  getHolderCount,
  getDeployerHistory,
  checkSellSimulation,
  getDexTokenPairs,
  searchDexBase,
  getBoostOrders,
  getTrendingMetas,
  getHolderConcentration,
  getWalletAgeStats,
  getFreshWalletRatio,
  getBuySellRatio,
  getTopYieldPools,
  getTopFeeAprPools,
  getTrendingBasePools,
  getBaseChainTvl,
  getProtocolStats,
  getDexVolumeOverview,
  getFeeRevenueOverview,
  getBridgeStats,
  getStablecoinStats,
  searchWeb,
} from "./tools.js";

const PORT = parseInt(process.env.PORT ?? "8788");
const app = express();
app.use(express.json());

// Session store: sessionId → transport
// Each MCP client (our bot or Anthropic's servers) gets a persistent session.
const sessions = new Map();

function buildServer() {
  const server = new McpServer({ name: "base-analytics-mcp", version: "1.0.0" });

  server.tool(
    "find_v4_pools",
    "Search Uniswap V4 PoolManager Initialize events on Base for pools containing a specific token address. Checks both currency0 and currency1 slots.",
    {
      token: z.string().describe("Token contract address to search for (0x...)"),
      fromBlock: z
        .number()
        .optional()
        .describe("Starting block number for log search (default: recent 100k blocks)"),
    },
    async ({ token, fromBlock }) => {
      const result = await findV4Pools(token, fromBlock);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_v4_pool_state",
    "Get current state of a Uniswap V4 pool: sqrtPriceX96, tick, protocolFee, lpFee, and total liquidity via StateView.",
    {
      poolId: z.string().describe("The pool ID (bytes32 hex string)"),
    },
    async ({ poolId }) => {
      const result = await getV4PoolState(poolId);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "compute_v4_reserves",
    "Compute token0/token1 reserve amounts for a concentrated liquidity position given the pool's current sqrtPriceX96 and position tick bounds.",
    {
      liquidity: z.string().describe("Position liquidity (as decimal string)"),
      sqrtPriceX96: z.string().describe("Current pool sqrtPriceX96 (as decimal string)"),
      tickLower: z.number().describe("Position lower tick"),
      tickUpper: z.number().describe("Position upper tick"),
      decimals0: z.number().describe("Decimals for token0 (usually 18)"),
      decimals1: z.number().describe("Decimals for token1 (usually 18)"),
    },
    async ({ liquidity, sqrtPriceX96, tickLower, tickUpper, decimals0, decimals1 }) => {
      const result = computeV4Reserves(liquidity, sqrtPriceX96, tickLower, tickUpper, decimals0, decimals1);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_top_holders",
    "Fetch the top token holders for a Base chain ERC-20 token via BaseScan API. Returns address, balance, and percentage of supply.",
    {
      tokenAddress: z.string().describe("ERC-20 token contract address on Base"),
      limit: z.number().optional().describe("Number of top holders to return (default 10, max 100)"),
    },
    async ({ tokenAddress, limit = 10 }) => {
      const result = await getTopHolders(tokenAddress, limit);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_holder_count",
    "Get the total number of holders for a Base chain ERC-20 token via BaseScan API.",
    {
      tokenAddress: z.string().describe("ERC-20 token contract address on Base"),
    },
    async ({ tokenAddress }) => {
      const result = await getHolderCount(tokenAddress);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_deployer_history",
    "Look up who deployed a contract on Base and retrieve the deployer's other contract deployments via Blockscout.",
    {
      contractAddress: z.string().describe("Contract address to look up on Base"),
    },
    async ({ contractAddress }) => {
      const result = await getDeployerHistory(contractAddress);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "check_sell_simulation",
    "Simulate a token sell swap via eth_call to check if it would revert. Reports 'simulated sell succeeded' or 'simulated sell reverted' — NOT a definitive honeypot verdict.",
    {
      tokenAddress: z.string().describe("Token to simulate selling"),
      poolManager: z.string().optional().describe("PoolManager address (default: V4 PoolManager)"),
      poolId: z.string().describe("Pool ID to route the swap through"),
      testAmount: z.string().describe("Amount of token to simulate selling (in token's smallest unit)"),
    },
    async ({ tokenAddress, poolManager, poolId, testAmount }) => {
      const result = await checkSellSimulation(tokenAddress, poolManager, poolId, testAmount);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_dex_token_pairs",
    "Get all DEX trading pairs for a Base token from DexScreener: price (USD + native), liquidity, 24h volume, buy/sell tx counts, price changes, and FDV. Sorted by liquidity. Free, no API key.",
    {
      tokenAddress: z.string().describe("Token contract address on Base"),
    },
    async ({ tokenAddress }) => {
      const result = await getDexTokenPairs(tokenAddress);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_dex_base",
    "Search Base chain DEX pairs by token symbol, name, or address via DexScreener. Useful for resolving $TICKER to a contract address or finding pairs when you only know the name.",
    {
      query: z.string().describe("Token symbol (e.g. VIRTUAL), name, or contract address"),
    },
    async ({ query }) => {
      const result = await searchDexBase(query);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_boost_orders",
    "Check if a Base token has paid for DexScreener boost promotions. Active boosts indicate a project is spending on visibility — relevant context alongside holder/trading analysis.",
    {
      tokenAddress: z.string().describe("Token contract address on Base"),
    },
    async ({ tokenAddress }) => {
      const result = await getBoostOrders(tokenAddress);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_trending_metas",
    "Get currently trending narrative metas from DexScreener (AI, memecoins, DePIN, etc.) with market cap, liquidity, volume, and token count. Cross-chain context, not Base-specific.",
    {},
    async () => {
      const result = await getTrendingMetas();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_holder_concentration",
    "Get the top 5 individual holder percentages and their combined total for a Base ERC-20 token. Returns a compact summary like '25.0·18.9·8.6·6.1·4.3 [64%]' and a concentration risk level.",
    {
      tokenAddress: z.string().describe("Token contract address on Base"),
    },
    async ({ tokenAddress }) => {
      const result = await getHolderConcentration(tokenAddress);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_wallet_age_stats",
    "For a sample of top token holders, estimates holder recency using their last-active block from Blockscout. Returns average weeks-since-last-activity and an active/dormant distribution. Note: true wallet creation date is unavailable via Blockscout for EOAs.",
    {
      tokenAddress: z.string().describe("Token contract address on Base"),
      sampleSize: z.number().optional().describe("Number of top holders to sample (default 20, max 50)"),
    },
    async ({ tokenAddress, sampleSize = 20 }) => {
      const result = await getWalletAgeStats(tokenAddress, Math.min(sampleSize, 50));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_fresh_wallet_ratio",
    "Scans ERC-20 Transfer recipients in the last 1 day and 7 days. For each unique buyer, checks if their wallet has fewer than 15 total transactions on Base (sniper/insider signal). Returns fresh-wallet % for both windows.",
    {
      tokenAddress: z.string().describe("Token contract address on Base"),
    },
    async ({ tokenAddress }) => {
      const result = await getFreshWalletRatio(tokenAddress);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_buy_sell_ratio",
    "Count buy vs sell swaps for a Uniswap V4 pool in the last N hours using eth_getLogs on the PoolManager Swap event. Determines buy/sell direction from the token's currency0/currency1 position. Returns counts, net sentiment, and raw volume.",
    {
      tokenAddress: z.string().describe("Token contract address on Base"),
      poolId: z.string().describe("V4 pool ID (bytes32)"),
      hours: z.number().optional().describe("Lookback window in hours (default 1, max 24)"),
    },
    async ({ tokenAddress, poolId, hours = 1 }) => {
      const result = await getBuySellRatio(tokenAddress, poolId, Math.min(hours, 24));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_base_chain_tvl",
    "Get the current Total Value Locked (TVL) for the Base chain plus top 15 protocols by Base TVL, including 1d/7d/30d change. Answers questions like 'what is Base TVL?' or 'which protocols have the most TVL on Base?'",
    {},
    async () => {
      const result = await getBaseChainTvl();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_protocol_stats",
    "Get TVL, 7-day TVL history on Base, and metadata for a specific DeFi protocol by name (e.g. 'aerodrome', 'uniswap', 'aave', 'compound'). Use for questions about a named protocol's performance on Base.",
    {
      protocol: z.string().describe("Protocol name as used on DeFiLlama (e.g. 'aerodrome', 'uniswap-v3', 'aave-v3')"),
    },
    async ({ protocol }) => {
      const result = await getProtocolStats(protocol);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_dex_volume_overview",
    "ALWAYS use this tool for any question about DEX volume, top protocols by volume, top DEXes, trading volume rankings, or 24h/7d volume on Base. Returns live volume data from DeFiLlama grouped by protocol. Do NOT use web search for volume questions — this tool has the authoritative live data.",
    {},
    async () => {
      const result = await getDexVolumeOverview();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_fee_revenue_overview",
    "Get protocol fees and revenue generated on Base in the last 24h and 7d, ranked by earnings. Useful for questions about which protocols earn the most fees or revenue on Base.",
    {},
    async () => {
      const result = await getFeeRevenueOverview();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_bridge_stats",
    "Get bridge volume and net flow (deposits vs withdrawals) for Base chain over the last 7 days, plus top bridges by volume. Answers questions about capital flowing in/out of Base.",
    {},
    async () => {
      const result = await getBridgeStats();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_stablecoin_stats",
    "Get the stablecoin market cap breakdown on Base — which stablecoins (USDC, USDT, DAI, etc.) are circulating and how much. Answers questions about stablecoin dominance or total stablecoin supply on Base.",
    {},
    async () => {
      const result = await getStablecoinStats();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_trending_base_pools",
    "Fetch currently trending liquidity pools on Base from GeckoTerminal. Returns volume across 5min, 1h, 6h, and 24h windows plus price change and buys/sells for each pool. Use this for questions about what's trending, hot, or most active on Base right now. Includes base token contract address for each pool.",
    {
      limit: z.number().optional().describe("Number of trending pools to return (default 10, max 20)"),
    },
    async ({ limit = 10 }) => {
      const result = await getTrendingBasePools({ limit: Math.min(limit, 20) });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_top_yield_pools",
    "Fetch the highest-APY liquidity pools on Base from DeFiLlama. Returns fee APY, reward APY, total APY, TVL, and 7-day impermanent loss for each pool. Use this for questions about total yield including token rewards. For fee-only APR questions use get_top_fee_apr_pools instead.",
    {
      minTvl: z.number().optional().describe("Minimum TVL in USD to filter noise (default 500000)"),
      maxApy: z.number().optional().describe("Maximum APY cap to exclude manipulated/outlier pools (default 10000, i.e. 10000%)"),
      sortBy: z.enum(["apy", "apyBase"]).optional().describe("Sort by 'apy' (total incl. rewards, default) or 'apyBase' (fee APY only, no reward tokens)"),
      limit: z.number().optional().describe("Number of top pools to return (default 10, max 25)"),
    },
    async ({ minTvl = 500_000, maxApy = 10_000, sortBy = "apy", limit = 10 }) => {
      const result = await getTopYieldPools({ minTvl, maxApy, sortBy, limit: Math.min(limit, 25) });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_top_fee_apr_pools",
    "Fetch the highest fee APR liquidity pools on Base. Uses Dune Analytics 7-day average volume for Aerodrome Slipstream and Uniswap V3 (stable, not inflated by single-day spikes), plus GeckoTerminal for TVL and fee tier. Uniswap V4 uses GeckoTerminal 24h volume. Fee APR = (vol × fee tier) / TVL × 365. Use this for any question about fee APR, fee ROI, or best LP fee earnings on Base.",
    {
      minTvl: z.number().optional().describe("Minimum pool TVL in USD (default 200000)"),
      limit: z.number().optional().describe("Number of top pools to return (default 10, max 25)"),
    },
    async ({ minTvl = 200_000, limit = 10 }) => {
      const result = await getTopFeeAprPools({ minTvl, limit: Math.min(limit, 25) });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_web",
    "LAST RESORT ONLY — use this tool only when the question cannot be answered by documentation context, on-chain tools, or any other available tool. Do not call this tool if the answer is available elsewhere. Use for Base ecosystem topics such as recent announcements, upgrades, or features not yet covered in indexed documentation.",
    {
      query: z.string().describe("The search query — be specific and include 'Base' or relevant context"),
      maxResults: z.number().optional().describe("Number of results to return (default 5, max 10)"),
    },
    async ({ query, maxResults = 5 }) => {
      const result = await searchWeb(query, Math.min(maxResults, 10));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

// POST /mcp — main JSON-RPC endpoint
app.post("/mcp", async (req, res) => {
  const existingSessionId = req.headers["mcp-session-id"];

  if (existingSessionId && sessions.has(existingSessionId)) {
    await sessions.get(existingSessionId).handleRequest(req, res, req.body);
    return;
  }

  // New session: create transport with session tracking
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      sessions.set(sid, transport);
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  const server = buildServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// GET /mcp — SSE endpoint for server-initiated messages
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(400).json({ error: "Valid Mcp-Session-Id header required" });
  }
  await sessions.get(sessionId).handleRequest(req, res);
});

// DELETE /mcp — session teardown
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && sessions.has(sessionId)) {
    await sessions.get(sessionId).handleRequest(req, res);
    sessions.delete(sessionId);
  } else {
    res.status(200).end();
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "base-analytics-mcp", version: "1.0.0", sessions: sessions.size });
});

// ─── REST API (Base MCP plugin / direct HTTP) ─────────────────────────────────
// These GET endpoints mirror every MCP tool so the server works as a Base MCP
// plugin via web_request and as a plain REST API without the JSON-RPC protocol.

function apiHandler(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

// GET /api/holder-count/:address
app.get("/api/holder-count/:address", apiHandler((req) =>
  getHolderCount(req.params.address)
));

// GET /api/holders/:address?limit=10
app.get("/api/holders/:address", apiHandler((req) =>
  getTopHolders(req.params.address, Math.min(parseInt(req.query.limit ?? "10"), 100))
));

// GET /api/deployer/:address
app.get("/api/deployer/:address", apiHandler((req) =>
  getDeployerHistory(req.params.address)
));

// GET /api/pools/:token?fromBlock=0
app.get("/api/pools/:token", apiHandler((req) =>
  findV4Pools(req.params.token, req.query.fromBlock ? parseInt(req.query.fromBlock) : undefined)
));

// GET /api/pool-state/:poolId
app.get("/api/pool-state/:poolId", apiHandler((req) =>
  getV4PoolState(req.params.poolId)
));

// GET /api/dex-pairs/:token
app.get("/api/dex-pairs/:token", apiHandler((req) =>
  getDexTokenPairs(req.params.token)
));

// GET /api/dex-search?q=VIRTUAL
app.get("/api/dex-search", apiHandler((req) =>
  searchDexBase(req.query.q ?? "")
));

// GET /api/boost-orders/:token
app.get("/api/boost-orders/:token", apiHandler((req) =>
  getBoostOrders(req.params.token)
));

// GET /api/trending-metas
app.get("/api/trending-metas", apiHandler(() =>
  getTrendingMetas()
));

// GET /api/holder-concentration/:token
app.get("/api/holder-concentration/:token", apiHandler((req) =>
  getHolderConcentration(req.params.token)
));

// GET /api/wallet-age/:token?sampleSize=20
app.get("/api/wallet-age/:token", apiHandler((req) =>
  getWalletAgeStats(req.params.token, Math.min(parseInt(req.query.sampleSize ?? "20"), 50))
));

// GET /api/fresh-wallets/:token
app.get("/api/fresh-wallets/:token", apiHandler((req) =>
  getFreshWalletRatio(req.params.token)
));

// GET /api/buy-sell/:token/:poolId?hours=1
app.get("/api/buy-sell/:token/:poolId", apiHandler((req) =>
  getBuySellRatio(req.params.token, req.params.poolId, Math.min(parseInt(req.query.hours ?? "1"), 24))
));

// GET /api/trending-pools?limit=10
app.get("/api/trending-pools", apiHandler((req) =>
  getTrendingBasePools({ limit: Math.min(parseInt(req.query.limit ?? "10"), 20) })
));

// GET /api/yield-pools?minTvl=500000&limit=10
app.get("/api/yield-pools", apiHandler((req) =>
  getTopYieldPools({
    minTvl: parseInt(req.query.minTvl ?? "500000"),
    limit: Math.min(parseInt(req.query.limit ?? "10"), 25),
  })
));

// GET /api/fee-apr-pools?minTvl=200000&limit=10
app.get("/api/fee-apr-pools", apiHandler((req) =>
  getTopFeeAprPools({
    minTvl: parseInt(req.query.minTvl ?? "200000"),
    limit: Math.min(parseInt(req.query.limit ?? "10"), 25),
  })
));

// GET /api/chain-tvl
app.get("/api/chain-tvl", apiHandler(() => getBaseChainTvl()));

// GET /api/protocol/:name
app.get("/api/protocol/:name", apiHandler((req) => getProtocolStats(req.params.name)));

// GET /api/dex-volume
app.get("/api/dex-volume", apiHandler(() => getDexVolumeOverview()));

// GET /api/fee-revenue
app.get("/api/fee-revenue", apiHandler(() => getFeeRevenueOverview()));

// GET /api/bridge-stats
app.get("/api/bridge-stats", apiHandler(() => getBridgeStats()));

// GET /api/stablecoins
app.get("/api/stablecoins", apiHandler(() => getStablecoinStats()));

// GET /api/compute-reserves?liquidity=&sqrtPriceX96=&tickLower=&tickUpper=&decimals0=&decimals1=
app.get("/api/compute-reserves", apiHandler((req) => {
  const { liquidity, sqrtPriceX96, tickLower, tickUpper, decimals0, decimals1 } = req.query;
  return computeV4Reserves(liquidity, sqrtPriceX96, parseInt(tickLower), parseInt(tickUpper), parseInt(decimals0 ?? "18"), parseInt(decimals1 ?? "18"));
}));

app.listen(PORT, () => {
  console.log(`base-analytics-mcp listening on port ${PORT}`);
  console.log(`MCP endpoint:  http://localhost:${PORT}/mcp`);
  console.log(`REST API:      http://localhost:${PORT}/api/`);
});

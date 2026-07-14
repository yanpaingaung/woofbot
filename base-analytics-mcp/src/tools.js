import { ethers } from "ethers";

const DEFAULT_RPC = "https://mainnet.base.org";
const POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const STATE_VIEW = "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71";
const BLOCKSCOUT = "https://base.blockscout.com/api/v2";
const DEXSCREENER = "https://api.dexscreener.com";
const DEFILLAMA_YIELDS = "https://yields.llama.fi";
const DEFILLAMA_API   = "https://api.llama.fi";
const DEFILLAMA_COINS = "https://coins.llama.fi";
const DEFILLAMA_BRIDGES = "https://bridges.llama.fi";
const DEFILLAMA_STABLES = "https://stablecoins.llama.fi";
const TAVILY_API = "https://api.tavily.com";

// Public Base RPC caps eth_getLogs at 10K blocks per request
const LOG_CHUNK = 9_900;
// Default search window: last 200K blocks (~5.5 days at 2s/block)
const DEFAULT_LOOKBACK = 200_000;
const RPC_CONCURRENCY = 4;

function getProvider() {
  return new ethers.JsonRpcProvider(process.env.BASE_RPC_URL ?? DEFAULT_RPC);
}

async function blockscoutFetch(path) {
  const res = await fetch(`${BLOCKSCOUT}${path}`, {
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`Blockscout HTTP ${res.status} for ${path}`);
  return res.json();
}

// ─── Uniswap V4 Initialize event ─────────────────────────────────────────────
const INITIALIZE_EVENT = new ethers.Interface([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);

const INITIALIZE_TOPIC = ethers.id(
  "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"
);

function asCurrency(addr) {
  return "0x" + addr.toLowerCase().replace("0x", "").padStart(64, "0");
}

// Chunk a block range into slices ≤ LOG_CHUNK blocks each
function blockChunks(from, to) {
  const chunks = [];
  for (let start = from; start <= to; start += LOG_CHUNK) {
    chunks.push({ from: start, to: Math.min(start + LOG_CHUNK - 1, to) });
  }
  return chunks;
}

// Exponential backoff for rate-limited RPC calls
async function getLogsWithRetry(provider, filter, retries = 4) {
  let delay = 1000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await provider.getLogs(filter);
    } catch (err) {
      const isRateLimit = err?.code === -32005 || /rate.limit|too many|429/i.test(err?.message ?? "");
      if (!isRateLimit || attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

// Query logs over all chunks, in parallel batches capped at RPC_CONCURRENCY
async function queryLogsChunked(provider, filter, from, to) {
  const chunks = blockChunks(from, to);
  const allLogs = [];

  for (let i = 0; i < chunks.length; i += RPC_CONCURRENCY) {
    const batch = chunks.slice(i, i + RPC_CONCURRENCY);
    const results = await Promise.all(
      batch.map((c) => getLogsWithRetry(provider, { ...filter, fromBlock: c.from, toBlock: c.to }))
    );
    results.forEach((logs) => allLogs.push(...logs));
  }

  return { logs: allLogs, chunksQueried: chunks.length };
}

export async function findV4Pools(token, fromBlock) {
  const provider = getProvider();
  const latest = await provider.getBlockNumber();
  const from = fromBlock ?? Math.max(0, latest - DEFAULT_LOOKBACK);

  const baseFilter = { address: POOL_MANAGER, topics: [INITIALIZE_TOPIC] };

  // Query currency0 == token and currency1 == token in parallel chunked batches
  const [res0, res1] = await Promise.all([
    queryLogsChunked(
      provider,
      { ...baseFilter, topics: [INITIALIZE_TOPIC, null, asCurrency(token), null] },
      from,
      latest
    ),
    queryLogsChunked(
      provider,
      { ...baseFilter, topics: [INITIALIZE_TOPIC, null, null, asCurrency(token)] },
      from,
      latest
    ),
  ]);

  const seen = new Set();
  const pools = [];

  for (const log of [...res0.logs, ...res1.logs]) {
    const parsed = INITIALIZE_EVENT.parseLog(log);
    if (!parsed) continue;
    const id = parsed.args.id;
    if (seen.has(id)) continue;
    seen.add(id);
    pools.push({
      poolId: id,
      currency0: parsed.args.currency0,
      currency1: parsed.args.currency1,
      fee: Number(parsed.args.fee),
      tickSpacing: Number(parsed.args.tickSpacing),
      hooks: parsed.args.hooks,
      sqrtPriceX96: parsed.args.sqrtPriceX96.toString(),
      tick: Number(parsed.args.tick),
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
    });
  }

  return {
    token,
    poolManagerAddress: POOL_MANAGER,
    searchedBlocks: { from, to: latest },
    chunksQueried: res0.chunksQueried + res1.chunksQueried,
    poolsFound: pools.length,
    pools,
  };
}

// ─── StateView ────────────────────────────────────────────────────────────────
const STATE_VIEW_ABI = [
  "function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity)",
];

export async function getV4PoolState(poolId) {
  const provider = getProvider();
  const stateView = new ethers.Contract(STATE_VIEW, STATE_VIEW_ABI, provider);
  const id = poolId.startsWith("0x") ? poolId : "0x" + poolId;

  const [slot0, liquidity] = await Promise.all([
    stateView.getSlot0(id),
    stateView.getLiquidity(id),
  ]);

  return {
    poolId: id,
    stateViewAddress: STATE_VIEW,
    sqrtPriceX96: slot0.sqrtPriceX96.toString(),
    tick: Number(slot0.tick),
    protocolFee: Number(slot0.protocolFee),
    lpFee: Number(slot0.lpFee),
    liquidity: liquidity.toString(),
  };
}

// ─── Reserve computation ──────────────────────────────────────────────────────
export function computeV4Reserves(
  liquidityStr,
  sqrtPriceX96Str,
  tickLower,
  tickUpper,
  decimals0,
  decimals1
) {
  const Q96 = 2n ** 96n;
  const L = BigInt(liquidityStr);
  const sqrtP = BigInt(sqrtPriceX96Str);

  function sqrtPriceAtTick(tick) {
    const sqrtPrice = Math.sqrt(Math.pow(1.0001, tick));
    return BigInt(Math.floor(sqrtPrice * Number(Q96)));
  }

  const sqrtPL = sqrtPriceAtTick(tickLower);
  const sqrtPU = sqrtPriceAtTick(tickUpper);
  const sqrtPClamped = sqrtP < sqrtPL ? sqrtPL : sqrtP > sqrtPU ? sqrtPU : sqrtP;

  const amount0Raw =
    sqrtPU > sqrtPClamped
      ? (L * Q96 * (sqrtPU - sqrtPClamped)) / (sqrtPClamped * sqrtPU)
      : 0n;

  const amount1Raw =
    sqrtPClamped > sqrtPL ? (L * (sqrtPClamped - sqrtPL)) / Q96 : 0n;

  return {
    amount0: Number(amount0Raw) / 10 ** decimals0,
    amount1: Number(amount1Raw) / 10 ** decimals1,
    amount0Raw: amount0Raw.toString(),
    amount1Raw: amount1Raw.toString(),
    decimals0,
    decimals1,
    note: "Assumes position is fully in-range.",
  };
}

// ─── Blockscout: top holders ──────────────────────────────────────────────────
export async function getTopHolders(tokenAddress, limit = 10) {
  const [tokenData, holdersData] = await Promise.all([
    blockscoutFetch(`/tokens/${tokenAddress}`),
    blockscoutFetch(`/tokens/${tokenAddress}/holders`),
  ]);

  const totalSupply = BigInt(tokenData.total_supply ?? "0");
  const decimals = parseInt(tokenData.decimals ?? "18");
  const items = (holdersData.items ?? []).slice(0, limit);

  return {
    tokenAddress,
    tokenName: tokenData.name,
    symbol: tokenData.symbol,
    totalHolderCount: tokenData.holders_count,
    totalSupply: tokenData.total_supply,
    decimals,
    topHolders: items.map((h) => {
      const balance = BigInt(h.value ?? "0");
      const pct = totalSupply > 0n ? (Number(balance) * 100 / Number(totalSupply)).toFixed(4) + "%" : "N/A";
      return {
        address: h.address.hash,
        label: h.address.name ?? h.address.metadata?.tags?.[0]?.name ?? null,
        rawBalance: h.value,
        formattedBalance: (Number(balance) / 10 ** decimals).toLocaleString(),
        percentOfSupply: pct,
      };
    }),
  };
}

// ─── Blockscout: holder count ─────────────────────────────────────────────────
// Blockscout's holders_count is an indexed value that crawls Transfer events
// progressively. For rapidly growing tokens it can lag by hours or more.
// We supplement with an on-chain unique-receiver count from recent Transfer logs
// as a lower-bound freshness cross-check.
export async function getHolderCount(tokenAddress) {
  const provider = getProvider();

  const [data, latest] = await Promise.all([
    blockscoutFetch(`/tokens/${tokenAddress}`),
    provider.getBlockNumber(),
  ]);

  // On-chain Transfer log count for last 24h: count unique recipient addresses
  // as a freshness signal (this is unique receivers, not current holders).
  let recentUniqueReceivers = null;
  try {
    const from24h = latest - BLOCKS_PER_DAY;
    const { logs } = await queryLogsChunked(
      provider,
      { address: tokenAddress, topics: [TRANSFER_TOPIC] },
      from24h,
      latest
    );
    const recipients = new Set();
    for (const log of logs) {
      try {
        const parsed = TRANSFER_IFACE.parseLog(log);
        if (parsed && parsed.args.to !== ethers.ZeroAddress) {
          recipients.add(parsed.args.to.toLowerCase());
        }
      } catch {}
    }
    recentUniqueReceivers = recipients.size;
  } catch {}

  const indexedCount = parseInt(data.holders_count ?? "0");

  return {
    tokenAddress,
    holderCount: data.holders_count,
    tokenName: data.name,
    symbol: data.symbol,
    totalSupply: data.total_supply,
    decimals: data.decimals,
    priceUsd: data.exchange_rate ?? null,
    marketCapUsd: data.circulating_market_cap ?? null,
    onChainLast24hUniqueReceivers: recentUniqueReceivers,
    indexingNote: recentUniqueReceivers !== null && recentUniqueReceivers > indexedCount * 0.05
      ? `Blockscout's indexed count (${data.holders_count}) may be significantly understated — ${recentUniqueReceivers.toLocaleString()} unique addresses received this token in the last 24h alone. True holder count is likely higher.`
      : "Blockscout indexed count. May lag by minutes to hours for high-velocity tokens.",
  };
}

// Returns how many days ago a contract was deployed, using Blockscout's creation tx timestamp.
// This is the authoritative source — more accurate than DexScreener pair creation dates.
async function getContractAgeDays(tokenAddress) {
  const addr = await blockscoutFetch(`/addresses/${tokenAddress}`);
  const txHash = addr.creation_tx_hash;
  if (!txHash) return null;
  const tx = await blockscoutFetch(`/transactions/${txHash}`);
  if (!tx.timestamp) return null;
  return Math.floor((Date.now() - new Date(tx.timestamp).getTime()) / 86_400_000);
}

// ─── Blockscout: deployer history ─────────────────────────────────────────────
export async function getDeployerHistory(contractAddress) {
  // Step 1: get creator from address info
  const addrData = await blockscoutFetch(`/addresses/${contractAddress}`);

  if (!addrData.creator_address_hash) {
    return {
      contractAddress,
      error: "No creator found. The address may be an EOA, a genesis contract, or not yet indexed by Blockscout.",
    };
  }

  const deployer = addrData.creator_address_hash;
  const creationTx = addrData.creation_tx_hash ?? null;

  // Step 2: find other contracts deployed by the same wallet via internal transactions
  let otherContracts = [];
  try {
    const txData = await blockscoutFetch(`/addresses/${deployer}/internal-transactions`);
    otherContracts = (txData.items ?? [])
      .filter((t) => t.type === "create" && t.created_contract?.hash)
      .filter((t) => t.created_contract.hash.toLowerCase() !== contractAddress.toLowerCase())
      .map((t) => ({
        contractAddress: t.created_contract.hash,
        contractName: t.created_contract.name ?? null,
        isVerified: t.created_contract.is_verified ?? false,
        txHash: t.transaction_hash,
        blockNumber: t.block_number,
        timestamp: t.timestamp,
      }));
  } catch {
    // Non-fatal — return what we have
  }

  return {
    contractAddress,
    contractName: addrData.name ?? null,
    isVerified: addrData.is_verified ?? false,
    deployer,
    deployerLabel: addrData.metadata?.tags?.[0]?.name ?? null,
    creationTxHash: creationTx,
    otherContractsDeployed: otherContracts,
  };
}

// ─── DexScreener helpers ──────────────────────────────────────────────────────
async function dexFetch(path) {
  const res = await fetch(`${DEXSCREENER}${path}`, {
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`DexScreener HTTP ${res.status} for ${path}`);
  return res.json();
}

function formatPair(p) {
  return {
    pairAddress: p.pairAddress,
    dex: p.dexId,
    baseToken: { address: p.baseToken?.address, name: p.baseToken?.name, symbol: p.baseToken?.symbol },
    quoteToken: { address: p.quoteToken?.address, symbol: p.quoteToken?.symbol },
    priceUsd: p.priceUsd ?? null,
    priceNative: p.priceNative ?? null,
    liquidity: p.liquidity ?? null,
    volume: p.volume ?? null,
    priceChange: p.priceChange ?? null,
    txns: p.txns ?? null,
    fdv: p.fdv ?? null,
    marketCap: p.marketCap ?? null,
    pairCreatedAt: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null,
    boosts: p.boosts ?? null,
    labels: p.labels ?? null,
  };
}

// get_dex_token_pairs — all DEX pairs for a Base token (price, volume, liquidity)
export async function getDexTokenPairs(tokenAddress) {
  const data = await dexFetch(`/token-pairs/v1/base/${tokenAddress}`);
  const pairs = Array.isArray(data) ? data : (data.pairs ?? []);
  const basePairs = pairs.filter((p) => p.chainId === "base");

  if (basePairs.length === 0) {
    return { tokenAddress, message: "No DEX pairs found on Base for this token.", pairs: [] };
  }

  // Primary pair = first in DexScreener's response (their canonical ranking).
  // Do NOT re-sort by volume or liquidity — that picks bot-traded/aggregator pairs
  // with inflated numbers instead of the main trading pair.
  const primary = basePairs[0];

  // Token age: contract deployment date from Blockscout (authoritative).
  // Falls back to oldest DexScreener pair date if Blockscout lookup fails.
  const contractAgeDays = await getContractAgeDays(tokenAddress).catch(() => null);
  const oldestPairMs = basePairs
    .map((p) => p.pairCreatedAt)
    .filter(Boolean)
    .reduce((min, t) => (t < min ? t : min), Infinity);
  const pairAgeDays = isFinite(oldestPairMs)
    ? Math.floor((Date.now() - oldestPairMs) / 86_400_000)
    : null;
  const tokenAgeDays = contractAgeDays ?? pairAgeDays;

  return {
    tokenAddress,
    pairsFound: basePairs.length,
    // Pre-computed summary so Claude doesn't have to choose — use these for the scan card
    summary: {
      symbol: primary.baseToken?.symbol ?? null,
      priceUsd: primary.priceUsd ?? null,
      fdv: primary.fdv ?? null,
      liquidityUsd: primary.liquidity?.usd ?? null,
      volume24hUsd: primary.volume?.h24 ?? null,   // from highest-volume pair
      priceChange24h: primary.priceChange?.h24 ?? null,
      priceChange1h: primary.priceChange?.h1 ?? null,
      buys24h: primary.txns?.h24?.buys ?? null,
      sells24h: primary.txns?.h24?.sells ?? null,
      primaryDex: primary.dexId ?? null,
      primaryPairAddress: primary.pairAddress ?? null,
      tokenAgeDays,                                 // from OLDEST pair across all DEXes
    },
    pairs: basePairs.map(formatPair),
  };
}

// search_dex_base — search Base pairs/tokens by symbol, name, or address
export async function searchDexBase(query) {
  const data = await dexFetch(`/latest/dex/search?q=${encodeURIComponent(query)}`);
  const pairs = (data.pairs ?? []).filter((p) => p.chainId === "base");

  if (pairs.length === 0) {
    return { query, message: "No Base pairs found matching this query.", pairs: [] };
  }

  pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

  return {
    query,
    pairsFound: pairs.length,
    topPairs: pairs.slice(0, 5).map(formatPair),
  };
}

// get_boost_orders — check if a token has active paid boost promotions on DexScreener
export async function getBoostOrders(tokenAddress) {
  const data = await dexFetch(`/orders/v1/base/${tokenAddress}`);
  const orders = Array.isArray(data) ? data : [];
  const activeBoosts = orders.filter((o) => o.status === "approved" || o.type === "tokenBoost");

  return {
    tokenAddress,
    totalOrders: orders.length,
    activeBoosts: activeBoosts.length,
    orders: orders.map((o) => ({
      type: o.type,
      status: o.status,
      paymentTimestamp: o.paymentTimestamp
        ? new Date(o.paymentTimestamp).toISOString()
        : null,
    })),
    note: activeBoosts.length > 0
      ? "Token has paid for DexScreener boost promotions — factor this into visibility analysis."
      : "No active boost orders found.",
  };
}

// get_trending_metas — trending narratives across DexScreener (not Base-specific)
export async function getTrendingMetas() {
  const data = await dexFetch("/metas/trending/v1");
  const metas = Array.isArray(data) ? data : [];
  return {
    count: metas.length,
    metas: metas.slice(0, 15).map((m) => ({
      name: m.name,
      slug: m.slug,
      marketCap: m.marketCap,
      liquidity: m.liquidity,
      volume: m.volume,
      tokenCount: m.tokenCount,
      marketCapChange: m.marketCapChange,
    })),
    note: "These are cross-chain trending narratives from DexScreener, not Base-specific.",
  };
}

// ─── Sell simulation ──────────────────────────────────────────────────────────
const SWAP_ABI = [
  "function swap(bytes32 key, (bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, bytes hookData) external returns (int256 delta0, int256 delta1)",
];

export async function checkSellSimulation(tokenAddress, poolManager, poolId, testAmount) {
  const pm = poolManager ?? POOL_MANAGER;
  const provider = getProvider();
  const pmContract = new ethers.Contract(pm, SWAP_ABI, provider);
  const id = poolId.startsWith("0x") ? poolId : "0x" + poolId;
  const amount = BigInt(testAmount);

  const sqrtLimitLow = 4295128739n;
  const sqrtLimitHigh = 1461446703485210103287273052203988822378723970342n - 1n;

  const results = [];
  for (const zeroForOne of [true, false]) {
    const sqrtPriceLimit = zeroForOne ? sqrtLimitLow : sqrtLimitHigh;
    try {
      const calldata = pmContract.interface.encodeFunctionData("swap", [
        id,
        { zeroForOne, amountSpecified: amount, sqrtPriceLimitX96: sqrtPriceLimit },
        "0x",
      ]);
      await provider.call({ to: pm, data: calldata });
      results.push({ zeroForOne, outcome: "simulated sell succeeded" });
    } catch (err) {
      results.push({ zeroForOne, outcome: "simulated sell reverted", reason: err?.reason ?? err?.message ?? "unknown" });
    }
  }

  return {
    tokenAddress,
    poolId: id,
    poolManager: pm,
    testAmount,
    simulations: results,
    disclaimer: "Read-only eth_call simulation only. Not a definitive honeypot assessment.",
  };
}

// ─── Tool 13: holder concentration ───────────────────────────────────────────
export async function getHolderConcentration(tokenAddress) {
  const [tokenData, holdersData] = await Promise.all([
    blockscoutFetch(`/tokens/${tokenAddress}`),
    blockscoutFetch(`/tokens/${tokenAddress}/holders`),
  ]);

  const totalSupply = BigInt(tokenData.total_supply ?? "0");
  const top = (holdersData.items ?? []).slice(0, 5);

  const top5 = top.map((h) => {
    const bal = BigInt(h.value ?? "0");
    const pct = totalSupply > 0n ? (Number(bal) * 100) / Number(totalSupply) : 0;
    return {
      address: h.address.hash,
      label: h.address.name ?? h.address.metadata?.tags?.[0]?.name ?? null,
      percentOfSupply: parseFloat(pct.toFixed(2)),
    };
  });

  const combined = parseFloat(top5.reduce((s, h) => s + h.percentOfSupply, 0).toFixed(2));

  return {
    tokenAddress,
    symbol: tokenData.symbol,
    totalHolderCount: tokenData.holders_count,
    top5,
    combinedTop5Percent: combined,
    concentrationRisk: combined > 50 ? "HIGH" : combined > 25 ? "MEDIUM" : "LOW",
    compactSummary: top5.map((h) => h.percentOfSupply.toFixed(1)).join("·") + ` [${combined.toFixed(0)}%]`,
  };
}

// ─── Tool 14: wallet age stats ────────────────────────────────────────────────
// Blockscout does not expose EOA creation timestamps, so we use
// block_number_balance_updated_at as a "last active" proxy. The field tells us
// the last block where the wallet's coin balance changed — useful for gauging
// whether holders are long-term or recently active.
const BLOCKS_PER_WEEK_BASE = 302_400; // 7d × 24h × 1800 blocks/h

export async function getWalletAgeStats(tokenAddress, sampleSize = 20) {
  const holdersData = await blockscoutFetch(`/tokens/${tokenAddress}/holders`);
  const holders = (holdersData.items ?? [])
    .filter((h) => !h.address.is_contract)
    .slice(0, sampleSize);

  const provider = getProvider();
  const latestBlock = await provider.getBlockNumber();

  const CONCURRENCY = 5;
  const stats = [];

  for (let i = 0; i < holders.length; i += CONCURRENCY) {
    const batch = holders.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (h) => {
        try {
          const data = await blockscoutFetch(`/addresses/${h.address.hash}`);
          const lastActiveBlock = data.block_number_balance_updated_at ?? null;
          const weeksSinceLastActivity = lastActiveBlock
            ? Math.round((latestBlock - lastActiveBlock) / BLOCKS_PER_WEEK_BASE)
            : null;
          return {
            address: h.address.hash,
            lastActiveBlock,
            weeksSinceLastActivity,
          };
        } catch {
          return { address: h.address.hash, lastActiveBlock: null, weeksSinceLastActivity: null };
        }
      })
    );
    stats.push(...results);
  }

  const withData = stats.filter((s) => s.weeksSinceLastActivity !== null);
  const avgWeeksSinceActive =
    withData.length > 0
      ? Math.round(withData.reduce((s, w) => s + w.weeksSinceLastActivity, 0) / withData.length)
      : null;

  return {
    tokenAddress,
    sampleSize: stats.length,
    avgWeeksSinceLastActivity: avgWeeksSinceActive,
    distribution: {
      activeLastWeek: withData.filter((w) => w.weeksSinceLastActivity <= 1).length,
      activeLastMonth: withData.filter((w) => w.weeksSinceLastActivity <= 4).length,
      dormantOver4Weeks: withData.filter((w) => w.weeksSinceLastActivity > 4).length,
    },
    note: "Blockscout does not expose EOA wallet creation timestamps. 'Weeks since last activity' (from block_number_balance_updated_at) is used as a holder-recency proxy, not true wallet age.",
  };
}

// ─── Tool 15: fresh wallet ratio ──────────────────────────────────────────────
// Scans ERC-20 Transfer recipients in the last 1d / 7d.
// A "fresh wallet" is one whose first-page of Blockscout transactions has fewer
// than FRESH_TX_THRESHOLD items AND no next_page_params (i.e. total tx count is
// below the threshold) — a sniper / insider signal.
const FRESH_TX_THRESHOLD = 15;
const BLOCKS_PER_DAY = 43_200;
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const TRANSFER_IFACE = new ethers.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export async function getFreshWalletRatio(tokenAddress) {
  const provider = getProvider();
  const latest = await provider.getBlockNumber();

  const from1d = latest - BLOCKS_PER_DAY;
  const from7d = latest - BLOCKS_PER_DAY * 7;

  // Fetch Transfer logs for both windows in parallel
  const [res7d] = await Promise.all([
    queryLogsChunked(
      provider,
      { address: tokenAddress, topics: [TRANSFER_TOPIC] },
      from7d,
      latest
    ),
  ]);

  const logs1d = res7d.logs.filter((l) => l.blockNumber >= from1d);
  const logs7d = res7d.logs;

  function uniqueBuyers(logs) {
    const buyers = new Set();
    for (const log of logs) {
      try {
        const parsed = TRANSFER_IFACE.parseLog(log);
        if (parsed && parsed.args.from !== ethers.ZeroAddress) {
          buyers.add(parsed.args.to.toLowerCase());
        }
      } catch {}
    }
    return buyers;
  }

  const buyers1d = uniqueBuyers(logs1d);
  const buyers7d = uniqueBuyers(logs7d);

  const SAMPLE = 30;
  const CONCURRENCY = 5;

  async function freshRatio(addresses) {
    const sample = [...addresses].slice(0, SAMPLE);
    const results = [];

    for (let i = 0; i < sample.length; i += CONCURRENCY) {
      const batch = sample.slice(i, i + CONCURRENCY);
      const batchRes = await Promise.all(
        batch.map(async (addr) => {
          try {
            const data = await blockscoutFetch(`/addresses/${addr}/transactions`);
            const items = data.items ?? [];
            const hasMore = !!data.next_page_params;
            // If there's no next page and items count is below threshold = fresh wallet
            const isFresh = !hasMore && items.length < FRESH_TX_THRESHOLD;
            return { addr, txCount: hasMore ? `>${items.length}` : items.length, isFresh };
          } catch {
            return { addr, txCount: null, isFresh: false };
          }
        })
      );
      results.push(...batchRes);
    }

    const fresh = results.filter((r) => r.isFresh).length;
    return {
      uniqueBuyers: addresses.size,
      sampleChecked: results.length,
      freshCount: fresh,
      freshPercent: results.length > 0 ? parseFloat(((fresh / results.length) * 100).toFixed(1)) : null,
    };
  }

  const [ratio1d, ratio7d] = await Promise.all([
    buyers1d.size > 0 ? freshRatio(buyers1d) : Promise.resolve(null),
    buyers7d.size > 0 ? freshRatio(buyers7d) : Promise.resolve(null),
  ]);

  const fresh1dPct = ratio1d?.freshPercent ?? null;

  return {
    tokenAddress,
    freshThreshold: `< ${FRESH_TX_THRESHOLD} total txs on Base`,
    window1d: ratio1d ?? { message: "No transfers in last 24h" },
    window7d: ratio7d ?? { message: "No transfers in last 7d" },
    sniperSignal: fresh1dPct !== null
      ? fresh1dPct > 40 ? "HIGH" : fresh1dPct > 20 ? "MEDIUM" : "LOW"
      : "UNKNOWN",
  };
}

// ─── Tool 16: buy/sell ratio (V4 Swap event logs) ────────────────────────────
// In Uniswap V4: currency0 < currency1 (lexicographic/numeric order).
// amount0 < 0 → pool gave currency0 to user → user BOUGHT currency0.
// We determine whether tokenAddress is currency0 or currency1 by comparison.
const SWAP_EVENT_IFACE = new ethers.Interface([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);
const SWAP_EVENT_TOPIC = ethers.id(
  "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"
);
const BLOCKS_PER_HOUR = 1800;

export async function getBuySellRatio(tokenAddress, poolId, hours = 1) {
  const provider = getProvider();
  const latest = await provider.getBlockNumber();
  const fromBlock = latest - Math.ceil(hours * BLOCKS_PER_HOUR);
  const id = poolId.startsWith("0x") ? poolId : "0x" + poolId;

  // Query Swap events for this specific pool in the time window
  const { logs } = await queryLogsChunked(
    provider,
    { address: POOL_MANAGER, topics: [SWAP_EVENT_TOPIC, id] },
    fromBlock,
    latest
  );

  // Determine token position: find the quoteToken from DexScreener to compare addresses
  let tokenIsC0 = null;
  let quoteSymbol = "unknown";
  try {
    const pairData = await getDexTokenPairs(tokenAddress);
    const pairs = pairData.pairs ?? [];
    const match = pairs.find(
      (p) => p.pairAddress?.toLowerCase() === poolId.toLowerCase()
    ) ?? pairs[0]; // fall back to most liquid pair

    if (match?.quoteToken?.address) {
      const quote = match.quoteToken.address.toLowerCase();
      tokenIsC0 = tokenAddress.toLowerCase() < quote;
      quoteSymbol = match.quoteToken.symbol ?? quote;
    }
  } catch {
    // Fallback: lexicographic comparison with WETH (most common Base quote)
    const WETH = "0x4200000000000000000000000000000000000006";
    tokenIsC0 = tokenAddress.toLowerCase() < WETH;
    quoteSymbol = "WETH (assumed)";
  }

  let buys = 0, sells = 0;
  let buyVolRaw = 0n, sellVolRaw = 0n;

  for (const log of logs) {
    try {
      const parsed = SWAP_EVENT_IFACE.parseLog(log);
      if (!parsed) continue;
      const a0 = BigInt(parsed.args.amount0.toString());
      const a1 = BigInt(parsed.args.amount1.toString());

      if (tokenIsC0 === true) {
        if (a0 < 0n) { buys++; buyVolRaw -= a0; }
        else { sells++; sellVolRaw += a0; }
      } else if (tokenIsC0 === false) {
        if (a1 < 0n) { buys++; buyVolRaw -= a1; }
        else { sells++; sellVolRaw += a1; }
      } else {
        if (a0 < 0n) buys++; else sells++;
      }
    } catch {}
  }

  return {
    tokenAddress,
    poolId: id,
    windowHours: hours,
    totalSwaps: logs.length,
    buys,
    sells,
    netSentiment: buys > sells ? "NET_BUY" : buys < sells ? "NET_SELL" : "NEUTRAL",
    quoteToken: quoteSymbol,
    tokenPosition: tokenIsC0 === true ? "currency0" : tokenIsC0 === false ? "currency1" : "unknown",
    buyVolumeRaw: buyVolRaw.toString(),
    sellVolumeRaw: sellVolRaw.toString(),
  };
}

// ─── GeckoTerminal: top fee APR pools on Base (direct from DEX subgraphs) ───────
const GECKO_BASE = "https://api.geckoterminal.com/api/v2";

const FEE_APR_DEXES = [
  { id: "aerodrome-slipstream", label: "Aerodrome Slipstream" },
  { id: "uniswap-v3-base",      label: "Uniswap V3" },
  { id: "uniswap-v4-base",      label: "Uniswap V4" },
];

function parseFeeFromName(name) {
  const m = name?.match(/(\d+\.?\d*)\s*%\s*$/);
  return m ? parseFloat(m[1]) / 100 : null;
}

async function fetchGeckoPools(dexId, pages = 4) {
  const pools = [];
  for (let page = 1; page <= pages; page++) {
    const r = await fetch(
      `${GECKO_BASE}/networks/base/dexes/${dexId}/pools?sort=h24_volume_usd_desc&page=${page}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000) }
    );
    if (!r.ok) break;
    const { data } = await r.json();
    if (!data?.length) break;
    for (const d of data) pools.push({ dexId, ...d.attributes });
    if (data.length < 20) break;
  }
  return pools;
}

// ─── Dune Analytics: 7-day average daily volume per pool ─────────────────────
// Covers Aerodrome Slipstream + Uniswap V3 (each has a unique pool contract).
// Uniswap V4 is excluded — all V4 pools share the PoolManager, making
// per-pool tracking impossible via dex.trades.
const DUNE_API_BASE = "https://api.dune.com/api/v1";
const DUNE_QUERY_ID = 7971532;

function buildDuneVolumeMap(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row.pool_address || row.avg_daily_vol_usd == null) continue;
    const addr = row.pool_address.startsWith("0x")
      ? row.pool_address.toLowerCase()
      : ("0x" + row.pool_address).toLowerCase();
    map.set(addr, Number(row.avg_daily_vol_usd));
  }
  return map;
}

async function fetchDune7dVolumeMap() {
  const apiKey = process.env.DUNE_API_KEY;
  if (!apiKey) return null;

  const headers = { "X-Dune-Api-Key": apiKey, Accept: "application/json" };

  // Try latest cached results first (instant if query ran within ~24h)
  try {
    const r = await fetch(`${DUNE_API_BASE}/query/${DUNE_QUERY_ID}/results`, {
      headers,
      signal: AbortSignal.timeout(12_000),
    });
    if (r.ok) {
      const data = await r.json();
      const rows = data.result?.rows;
      if (rows?.length) return buildDuneVolumeMap(rows);
    }
  } catch { /* fall through to fresh execution */ }

  // No cache — execute fresh and poll
  try {
    const execR = await fetch(`${DUNE_API_BASE}/query/${DUNE_QUERY_ID}/execute`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!execR.ok) return null;
    const { execution_id } = await execR.json();
    if (!execution_id) return null;

    // Poll every 5s, up to 60s total
    for (let i = 0; i < 12; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const statusR = await fetch(
        `${DUNE_API_BASE}/execution/${execution_id}/results`,
        { headers, signal: AbortSignal.timeout(12_000) }
      );
      if (!statusR.ok) continue;
      const data = await statusR.json();
      if (data.state === "QUERY_STATE_COMPLETED") {
        const rows = data.result?.rows;
        return rows?.length ? buildDuneVolumeMap(rows) : null;
      }
      if (data.state === "QUERY_STATE_FAILED" || data.state === "QUERY_STATE_CANCELLED") return null;
    }
  } catch { /* timeout or network error */ }

  return null;
}

export async function getTopFeeAprPools({ minTvl = 200_000, limit = 10 } = {}) {
  const DEX_LABELS = Object.fromEntries(FEE_APR_DEXES.map((d) => [d.id, d.label]));

  // Fetch Dune 7d volume map + GeckoTerminal pools in parallel
  const [duneMap, settled] = await Promise.all([
    fetchDune7dVolumeMap(),
    Promise.allSettled(FEE_APR_DEXES.map((d) => fetchGeckoPools(d.id))),
  ]);

  const allPools = settled
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value);

  const mapped = allPools
    .filter((p) => {
      const tvl = parseFloat(p.reserve_in_usd ?? 0);
      const vol = parseFloat(p.volume_usd?.h24 ?? 0);
      // Reject micro-pools, zero-volume, and pools without a parseable fee tier
      if (tvl < minTvl || vol <= 0 || parseFeeFromName(p.name) === null) return false;
      // Reject suspected wash-trading: daily vol >30× TVL is not organic
      if (vol / tvl > 30) return false;
      return true;
    })
    .map((p) => {
      const tvl = parseFloat(p.reserve_in_usd);
      const vol24h = parseFloat(p.volume_usd.h24);
      const fee = parseFeeFromName(p.name);
      const pairName = p.name.replace(/\s+\d+\.?\d*\s*%\s*$/, "").replace(" / ", "/").trim();
      const poolAddr = (p.address ?? "").toLowerCase();

      // V4 shares one PoolManager contract — Dune can't distinguish individual pools
      const isV4 = p.dexId === "uniswap-v4-base";
      const duneVol = (!isV4 && duneMap) ? (duneMap.get(poolAddr) ?? null) : null;
      // min(24h, 7d_avg): prevents spike-day inflation without over-inflating on quiet days
      const effectiveVol = duneVol != null ? Math.min(vol24h, duneVol) : vol24h;

      const feeAprPct = (effectiveVol * fee / tvl) * 365 * 100;

      return {
        dex: DEX_LABELS[p.dexId] ?? p.dexId,
        pair: pairName,
        feeTierPct: parseFloat((fee * 100).toFixed(4)),
        tvlUsd: Math.round(tvl),
        volume7dAvgUsd: duneVol != null ? Math.round(duneVol) : null,
        volume24hUsd: Math.round(vol24h),
        feeAprPct: Math.round(feeAprPct * 10) / 10,
        poolAddress: poolAddr,
        _vol24h: vol24h, // used for dedup; stripped below
      };
    })
    .filter((p) => p.feeAprPct > 0 && p.feeAprPct < 5_000);

  // Deduplicate by pair name: when the same pair has multiple fee tiers (e.g. VIRTUAL/WETH
  // at 0.05% and 0.7%), keep only the pool with the highest 24h volume. This matches the
  // "main" pool users see on Aerodrome/Uniswap UIs rather than a niche high-fee-tier variant.
  const byPair = new Map();
  for (const p of mapped) {
    const key = `${p.dex}|${p.pair}`;
    if (!byPair.has(key) || p._vol24h > byPair.get(key)._vol24h) byPair.set(key, p);
  }

  const pools = [...byPair.values()]
    .map(({ _vol24h, ...rest }) => rest) // drop internal field
    .sort((a, b) => b.feeAprPct - a.feeAprPct)
    .slice(0, limit);

  return {
    dataSource: duneMap
      ? "Dune Analytics 7d avg vol (Aerodrome/Uni V3) + GeckoTerminal TVL/fee tier"
      : "GeckoTerminal 24h vol (Dune unavailable — results may be inflated on spike days)",
    pools,
  };
}

// ─── GeckoTerminal: trending pools on Base ───────────────────────────────────
export async function getTrendingBasePools({ limit = 10 } = {}) {
  const r = await fetch(
    `${GECKO_BASE}/networks/base/trending_pools?page=1`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000) }
  );
  if (!r.ok) throw new Error(`GeckoTerminal HTTP ${r.status}`);
  const { data } = await r.json();

  // GeckoTerminal puts token addresses in relationships, not attributes.
  // id format: "{network}_{address}" e.g. "base_0xabc..."
  function extractAddr(rel) {
    const id = rel?.data?.id ?? "";
    const parts = id.split("_");
    return parts.length >= 2 ? parts.slice(1).join("_") : null;
  }

  const pools = (data ?? []).slice(0, limit).map((d) => {
    const a = d.attributes;
    const baseToken = a.name?.split(" / ")[0]?.trim() ?? a.name;
    const baseTokenAddress = extractAddr(d.relationships?.base_token);
    const quoteTokenAddress = extractAddr(d.relationships?.quote_token);
    const dexId = d.relationships?.dex?.data?.id ?? a.dex_id ?? null;
    return {
      name: a.name,
      baseToken,
      baseTokenAddress,
      quoteTokenAddress,
      poolAddress: a.address,
      dex: dexId,
      priceUsd: a.base_token_price_usd ?? null,
      priceChange: {
        m5:  a.price_change_percentage?.m5  ?? null,
        h1:  a.price_change_percentage?.h1  ?? null,
        h6:  a.price_change_percentage?.h6  ?? null,
        h24: a.price_change_percentage?.h24 ?? null,
      },
      volumeUsd: {
        m5:  parseFloat(a.volume_usd?.m5  ?? 0),
        h1:  parseFloat(a.volume_usd?.h1  ?? 0),
        h6:  parseFloat(a.volume_usd?.h6  ?? 0),
        h24: parseFloat(a.volume_usd?.h24 ?? 0),
      },
      liquidityUsd: parseFloat(a.reserve_in_usd ?? 0),
      txns24h: {
        buys:  a.transactions?.h24?.buys  ?? null,
        sells: a.transactions?.h24?.sells ?? null,
      },
    };
  });

  return { chain: "Base", source: "GeckoTerminal trending_pools", count: pools.length, pools };
}

// ─── DeFiLlama: top yield pools on Base ───────────────────────────────────────
export async function getTopYieldPools({ minTvl = 500_000, maxApy = 10_000, sortBy = "apy", limit = 10 } = {}) {
  const res = await fetch(`${DEFILLAMA_YIELDS}/pools`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`DeFiLlama HTTP ${res.status}`);
  const { data } = await res.json();

  const sortKey = sortBy === "apyBase" ? "apyBase" : "apy";
  const basePools = (data ?? [])
    .filter((p) =>
      p.chain === "Base" &&
      (p.tvlUsd ?? 0) >= minTvl &&
      (p.apy ?? 0) > 0 &&
      (p.apy ?? 0) <= maxApy
    )
    .sort((a, b) => (b[sortKey] ?? 0) - (a[sortKey] ?? 0))
    .slice(0, limit);

  return {
    chain: "Base",
    minTvlUsd: minTvl,
    maxApyCap: maxApy,
    sortBy: sortKey,
    count: basePools.length,
    pools: basePools.map((p) => ({
      project: p.project,
      symbol: p.symbol,
      tvlUsd: p.tvlUsd,
      apy: p.apy,
      apyBase: p.apyBase,
      apyReward: p.apyReward,
      il7d: p.il7d,
      poolAddress: p.pool,
      underlyingTokens: p.underlyingTokens ?? [],
    })),
  };
}

// ─── DeFiLlama helpers ────────────────────────────────────────────────────────
async function llamaFetch(baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`DeFiLlama HTTP ${res.status} for ${path}`);
  return res.json();
}

// ─── DeFiLlama: Base chain TVL + top protocols ────────────────────────────────
export async function getBaseChainTvl() {
  const [chains, protocols] = await Promise.all([
    llamaFetch(DEFILLAMA_API, "/v2/chains"),
    llamaFetch(DEFILLAMA_API, "/protocols"),
  ]);

  const base = chains.find((c) => c.name === "Base") ?? {};

  // Use only the "Base" key — matches DeFiLlama website default.
  const EXCLUDE_CATEGORIES = new Set(["CEX", "Chain", "Infrastructure"]);

  // Strip version suffixes to get the parent protocol name for grouping.
  // e.g. "Uniswap V3" → "Uniswap", "Aerodrome Slipstream" → "Aerodrome"
  function parentName(name) {
    return name
      .replace(/\s+v\d+(\.\d+)?$/i, "")
      .replace(/\s+(slipstream|classic|stable|volatile|amm|finance|lending|vaults?|ignition|launchpad|perpetuals?|perps?)$/i, "")
      .trim();
  }

  // TVL = Base (core liquidity) + Base-pool2 (protocol's own token LPs)
  // Exclude Base-borrowed (loans outstanding — already inside Base for lending protocols)
  const raw = protocols
    .filter((p) => (p.chainTvls?.Base ?? 0) > 0 && !EXCLUDE_CATEGORIES.has(p.category))
    .map((p) => ({
      name: p.name,
      category: p.category,
      tvlUsd: (p.chainTvls.Base ?? 0) + (p.chainTvls["Base-pool2"] ?? 0),
      change1d: p.change_1d ?? null,
    }));

  // Group by parent name — sum TVL, keep highest-TVL entry's category
  const grouped = new Map();
  for (const p of raw) {
    const key = parentName(p.name);
    if (!grouped.has(key)) {
      grouped.set(key, { name: key, category: p.category, tvlUsd: 0, versions: [] });
    }
    const g = grouped.get(key);
    g.tvlUsd += p.tvlUsd;
    g.versions.push(p.name);
  }

  const baseProtocols = [...grouped.values()]
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, 15)
    .map((g) => ({
      name: g.name,
      category: g.category,
      tvlUsd: g.tvlUsd,
      versions: g.versions.length > 1 ? g.versions : undefined,
    }));

  return {
    chain: "Base",
    tvlUsd: base.tvl ?? null,
    change1d: base.change_1d ?? null,
    change7d: base.change_7d ?? null,
    change1m: base.change_1m ?? null,
    topProtocols: baseProtocols,
  };
}

// ─── DeFiLlama: specific protocol TVL + breakdown ────────────────────────────
export async function getProtocolStats(protocol) {
  const slug = protocol.toLowerCase().replace(/\s+/g, "-");
  const data = await llamaFetch(DEFILLAMA_API, `/protocol/${slug}`);

  // Extract Base-specific TVL from the chain breakdown
  const baseTvl = data.currentChainTvls?.Base ?? null;
  const totalTvl = data.tvl?.at(-1)?.totalLiquidityUSD ?? null;

  // Recent daily TVL snapshots for Base
  const baseHistory = (data.chainTvls?.Base?.tvl ?? [])
    .slice(-7)
    .map((d) => ({ date: new Date(d.date * 1000).toISOString().slice(0, 10), tvlUsd: d.totalLiquidityUSD }));

  return {
    name: data.name,
    category: data.category,
    description: data.description?.slice(0, 200) ?? null,
    baseTvlUsd: baseTvl,
    totalTvlUsd: totalTvl,
    chains: data.chains ?? [],
    baseTvlLast7Days: baseHistory,
    url: data.url ?? null,
    twitter: data.twitter ?? null,
  };
}

// ─── DeFiLlama: DEX volume overview on Base ──────────────────────────────────
export async function getDexVolumeOverview() {
  const data = await llamaFetch(
    DEFILLAMA_API,
    "/overview/dexs/base?excludeTotalDataChartBreakdown=true&excludeTotalDataChart=true"
  );

  function parentName(name) {
    return name
      .replace(/\s+v\d+(\.\d+)?$/i, "")
      .replace(/\s+(slipstream|classic|stable|volatile|amm|finance|lending|vaults?|ignition|launchpad|perpetuals?|perps?)$/i, "")
      .trim();
  }

  // Group versions of the same protocol (e.g. Uniswap V3 + V4 → Uniswap)
  const grouped = new Map();
  for (const p of (data.protocols ?? [])) {
    const vol = p.total24h ?? 0;
    if (vol <= 0) continue;
    const key = parentName(p.displayName ?? p.name);
    if (!grouped.has(key)) {
      grouped.set(key, { name: key, volume24h: 0, volume7d: 0, change24h: null, versions: [] });
    }
    const g = grouped.get(key);
    g.volume24h += vol;
    g.volume7d += p.total7d ?? 0;
    g.versions.push(p.displayName ?? p.name);
    // weighted change: keep the change from the highest-volume version
    if (p.change_1d != null && (g.change24h === null || vol > (g._topVol ?? 0))) {
      g.change24h = p.change_1d;
      g._topVol = vol;
    }
  }

  const dexes = [...grouped.values()]
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, 12)
    .map(({ _topVol, versions, ...g }) => ({
      ...g,
      versions: versions.length > 1 ? versions : undefined,
    }));

  return {
    chain: "Base",
    totalVolume24h: data.total24h ?? null,
    totalVolume7d: data.total7d ?? null,
    change24h: data.change_1d ?? null,
    dexes,
  };
}

// ─── DeFiLlama: fees & revenue overview on Base ──────────────────────────────
// Fees = what users pay. Revenue = what the protocol keeps (its cut of fees).
// These are separate DeFiLlama endpoints with dataType parameter.
export async function getFeeRevenueOverview() {
  const BASE = "?excludeTotalDataChartBreakdown=true&excludeTotalDataChart=true";

  const [feesData, revData] = await Promise.all([
    llamaFetch(DEFILLAMA_API, `/overview/fees/base${BASE}`),
    llamaFetch(DEFILLAMA_API, `/overview/fees/base${BASE}&dataType=dailyRevenue`),
  ]);

  const mapProtocols = (data, valueKey) =>
    (data.protocols ?? [])
      .filter((p) => (p.total24h ?? 0) > 0)
      .sort((a, b) => (b.total24h ?? 0) - (a.total24h ?? 0))
      .slice(0, 12)
      .map((p) => ({
        name: p.displayName ?? p.name,
        [valueKey + "24h"]: p.total24h ?? null,
        [valueKey + "7d"]: p.total7d ?? null,
        change1d: p.change_1d ?? null,
      }));

  return {
    chain: "Base",
    totalFees24h: feesData.total24h ?? null,
    totalFees7d: feesData.total7d ?? null,
    totalRevenue24h: revData.total24h ?? null,
    totalRevenue7d: revData.total7d ?? null,
    topByRevenue: mapProtocols(revData, "revenue"),   // sorted by protocol revenue
    topByFees: mapProtocols(feesData, "fees"),         // sorted by fees paid by users
  };
}

// ─── DeFiLlama: bridge volume on Base ────────────────────────────────────────
export async function getBridgeStats() {
  const [summary, volume] = await Promise.all([
    llamaFetch(DEFILLAMA_BRIDGES, "/bridges?includeChains=true"),
    llamaFetch(DEFILLAMA_BRIDGES, "/bridgevolume/Base"),
  ]);

  // Top bridges by Base volume
  const bridges = (summary.bridges ?? [])
    .filter((b) => b.chains?.includes("Base"))
    .sort((a, b) => (b.lastDailyVolume ?? 0) - (a.lastDailyVolume ?? 0))
    .slice(0, 8)
    .map((b) => ({
      name: b.displayName ?? b.name,
      lastDailyVolume: b.lastDailyVolume ?? null,
    }));

  // Last 7 days of net flow
  const recentFlow = (volume ?? []).slice(-7).map((d) => ({
    date: new Date(d.date * 1000).toISOString().slice(0, 10),
    depositUsd: d.depositUSD ?? null,
    withdrawUsd: d.withdrawUSD ?? null,
    netFlowUsd: (d.depositUSD ?? 0) - (d.withdrawUSD ?? 0),
  }));

  const latest = recentFlow.at(-1) ?? {};

  return {
    chain: "Base",
    latest24hDepositUsd: latest.depositUsd ?? null,
    latest24hWithdrawUsd: latest.withdrawUsd ?? null,
    latest24hNetFlowUsd: latest.netFlowUsd ?? null,
    topBridges: bridges,
    last7DaysFlow: recentFlow,
  };
}

// ─── DeFiLlama: stablecoin stats on Base ─────────────────────────────────────
export async function getStablecoinStats() {
  const [chains, coins] = await Promise.all([
    llamaFetch(DEFILLAMA_STABLES, "/stablecoinchains"),
    llamaFetch(DEFILLAMA_STABLES, "/stablecoins?includePrices=true"),
  ]);

  const baseChain = (chains ?? []).find((c) => c.name === "Base") ?? {};

  // Stablecoins with Base-chain market cap
  const baseCoins = (coins.peggedAssets ?? [])
    .map((c) => {
      const baseCirculating = c.chainCirculating?.Base?.current?.peggedUSD ?? 0;
      return baseCirculating > 0
        ? { symbol: c.symbol, name: c.name, circulatingUsd: baseCirculating, pegType: c.pegType }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.circulatingUsd - a.circulatingUsd)
    .slice(0, 10);

  return {
    chain: "Base",
    totalStablecoinMcapUsd: baseChain.totalCirculatingUSD?.peggedUSD ?? null,
    stablecoins: baseCoins,
  };
}

// ─── Tavily: web search fallback ──────────────────────────────────────────────
export async function searchWeb(query, maxResults = 5) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY env var is not set");

  const res = await fetch(`${TAVILY_API}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      include_answer: true,
      max_results: maxResults,
      include_domains: ["base.org", "docs.base.org", "coinbase.com", "github.com/base-org"],
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tavily HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();

  return {
    answer: data.answer ?? null,
    results: (data.results ?? []).map((r) => ({
      title: r.title,
      content: r.content,
      score: r.score,
    })),
  };
}

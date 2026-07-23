import { config, EXCLUDED_TOKEN_SYMBOLS, EXCLUDED_TOKEN_ADDRESSES } from '../config.js';
import { getTokenPairs } from '../sources/dexscreener.js';
import { isSafeToken } from '../sources/goplus.js';
import { newTokenTweet, largeEarlyBuyTweet } from '../templates.js';
import { isDuplicate, markSeen } from '../dedup.js';
import { postTweet } from '../twitter.js';
import { logAlert } from '../db.js';
import type { RpcWs } from './ws.js';

// Uniswap V2 PairCreated(address indexed token0, address indexed token1, address pair, uint)
// Covers: Uniswap V2, SushiSwap, BaseSwap V2, PancakeSwap V2, and every other V2 fork on Base
const UNISWAP_V2_PAIR_CREATED = '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9';

// Uniswap V3 PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24, address)
// Covers: Uniswap V3, PancakeSwap V3, BaseSwap V3, Aerodrome CL, and every other V3 fork on Base
const UNISWAP_V3_POOL_CREATED = '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118';

// Aerodrome/Velodrome V1 PairCreated(address indexed token0, address indexed token1, bool stable, address pair, uint)
const AERODROME_PAIR_CREATED = '0xc4805696c66d7cf352fc1d6bb633ad5ee82f6cb577c453024b6e0eb8306c6fc9';

// Uniswap V4 Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)
// V4 uses a singleton PoolManager — no individual pool contracts
const UNISWAP_V4_INITIALIZE = '0xdd466e674ea557f56295e2d0218a125d5f2b585579da4adbe7b06e33a7dc10b9';
const UNISWAP_V4_POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b'; // Base mainnet

// In V4, native ETH is address(0), not WETH
const ETH_ZERO = '0x0000000000000000000000000000000000000000';

const MAX_WATCH_MS = 24 * 60 * 60 * 1000;
const VOLUME_POLL_MS = 2 * 60 * 1000; // check DexScreener every 2 min
const EARLY_BUY_PCT = 5;
const EARLY_BUY_MIN_USD = 1_000;

interface WatchedPool {
  poolAddress: string;
  tokenAddress: string;
  detectedAt: number;
  alerted: boolean;
}

const _pools = new Map<string, WatchedPool>(); // poolAddress → entry

interface Log {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
}

// Extract Ethereum address from a 32-byte padded topic
function addrFromTopic(topic: string): string {
  return ('0x' + topic.slice(-40)).toLowerCase();
}

// Extract address from a 32-byte ABI word (last 20 bytes)
function addrFromWord(hex64: string): string {
  return ('0x' + hex64.slice(24)).toLowerCase();
}

function addToWatchList(poolKey: string, token0: string, token1: string, tokenOverride?: string): void {
  if (_pools.has(poolKey)) return;

  let tokenAddress: string;
  if (tokenOverride) {
    tokenAddress = tokenOverride;
  } else {
    const isToken0Excluded = EXCLUDED_TOKEN_ADDRESSES.has(token0);
    const isToken1Excluded = EXCLUDED_TOKEN_ADDRESSES.has(token1);
    if (isToken0Excluded && isToken1Excluded) return;
    tokenAddress = isToken0Excluded ? token1 : token0;
  }

  _pools.set(poolKey, {
    poolAddress: poolKey,
    tokenAddress,
    detectedAt: Date.now(),
    alerted: false,
  });
  console.log(`[token-stream] New pool: ${poolKey.slice(0, 20)}... token=${tokenAddress}`);
}

// V2: data = abi.encode(pair, totalPairs) — pair is first 32-byte word
function onV2PairCreated(log: Log): void {
  if (log.topics.length < 3) return;
  const token0 = addrFromTopic(log.topics[1]);
  const token1 = addrFromTopic(log.topics[2]);
  const dataHex = log.data.slice(2);
  if (dataHex.length < 64) return;
  const pair = addrFromWord(dataHex.slice(0, 64)); // first word
  addToWatchList(pair, token0, token1);
}

// V4: topics[1]=poolId(bytes32), topics[2]=currency0, topics[3]=currency1
// No pool contract — identified by PoolId hash. Native ETH = address(0).
function onV4Initialize(log: Log): void {
  if (log.address.toLowerCase() !== UNISWAP_V4_POOL_MANAGER) return;
  if (log.topics.length < 4) return;

  const currency0 = addrFromTopic(log.topics[2]);
  const currency1 = addrFromTopic(log.topics[3]);

  const isC0Excluded = currency0 === ETH_ZERO || EXCLUDED_TOKEN_ADDRESSES.has(currency0);
  const isC1Excluded = currency1 === ETH_ZERO || EXCLUDED_TOKEN_ADDRESSES.has(currency1);
  if (isC0Excluded && isC1Excluded) return;

  const tokenAddress = isC0Excluded ? currency1 : currency0;
  const poolId = log.topics[1]; // bytes32 PoolId — unique per pool config

  addToWatchList(poolId, currency0, currency1, tokenAddress);
}

// V3: data = abi.encode(tickSpacing, pool) — pool is second 32-byte word
function onV3PoolCreated(log: Log): void {
  if (log.topics.length < 4) return;
  const token0 = addrFromTopic(log.topics[1]);
  const token1 = addrFromTopic(log.topics[2]);
  const dataHex = log.data.slice(2);
  if (dataHex.length < 128) return;
  const pool = addrFromWord(dataHex.slice(64, 128)); // second word
  addToWatchList(pool, token0, token1);
}

function onAerodromePairCreated(log: Log): void {
  if (log.topics.length < 3) return;
  const token0 = addrFromTopic(log.topics[1]);
  const token1 = addrFromTopic(log.topics[2]);
  // data = abi.encode(stable, pair, totalPairs) → three 32-byte words
  const dataHex = log.data.slice(2);
  if (dataHex.length < 128) return;
  const pair = addrFromWord(dataHex.slice(64, 128)); // second word
  addToWatchList(pair, token0, token1);
}

async function checkPool(watched: WatchedPool): Promise<void> {
  const pairs = await getTokenPairs(watched.tokenAddress);
  await new Promise(r => setTimeout(r, 300));

  const pair = pairs.find(p => p.pairAddress.toLowerCase() === watched.poolAddress)
    ?? pairs[0];
  if (!pair) return;

  const tokenSymbol = (
    pair.baseToken.address.toLowerCase() === watched.tokenAddress
      ? pair.baseToken.symbol
      : pair.quoteToken.symbol
  ).toUpperCase();

  const tokenName = pair.baseToken.address.toLowerCase() === watched.tokenAddress
    ? pair.baseToken.name
    : pair.quoteToken.name;

  if (EXCLUDED_TOKEN_SYMBOLS.has(tokenSymbol)) {
    _pools.delete(watched.poolAddress);
    return;
  }

  if (!(await isSafeToken(watched.tokenAddress))) {
    console.log(`[token-stream] Honeypot removed: $${tokenSymbol}`);
    _pools.delete(watched.poolAddress);
    return;
  }

  const liquidityUsd = pair.liquidity?.usd ?? 0;
  const volumeH6 = pair.volume?.h6 ?? 0;
  const volumeM5 = pair.volume?.m5 ?? 0;
  const dexId = pair.dexId;
  const ageMin = Math.floor((Date.now() - watched.detectedAt) / 60_000);

  if (liquidityUsd < config.newTokenLiquidityMin) return;

  // New token: $30K+ 6h volume AND $50K+ liquidity
  // DexScreener has no 3h bucket — h6 is the closest available above h1
  const newKey = `newtoken:${watched.poolAddress}`;
  if (volumeH6 >= config.newTokenBuyThreshold && !(await isDuplicate(newKey))) {
    const text = newTokenTweet({
      tokenName,
      tokenSymbol,
      dexId,
      liquidityUsd,
      totalBuyUsd: volumeH6,
      poolAgeMin: ageMin,
      tokenAddress: watched.tokenAddress,
    });
    await markSeen(newKey);
    const tweetId = await postTweet(text);
    await logAlert('new_token', newKey, text, tweetId ?? undefined, {
      poolAddress: watched.poolAddress, liquidityUsd, volumeH6,
    });
    watched.alerted = true;
    console.log(`[token-stream] Alert: $${tokenSymbol} 6h=$${volumeH6.toFixed(0)} liq=$${liquidityUsd.toFixed(0)}`);
  }

  // Large early buy: 5-min volume ≥ 5% of liquidity
  if (volumeM5 >= EARLY_BUY_MIN_USD && liquidityUsd > 0) {
    const pct = (volumeM5 / liquidityUsd) * 100;
    if (pct >= EARLY_BUY_PCT) {
      const earlyKey = `earlybuy:${watched.poolAddress}:${Math.floor(Date.now() / (5 * 60_000))}`;
      if (!(await isDuplicate(earlyKey))) {
        const text = largeEarlyBuyTweet({
          tokenSymbol,
          amountUsd: volumeM5,
          liquidityUsd,
          pctOfLiquidity: pct,
        });
        await markSeen(earlyKey);
        const tweetId = await postTweet(text);
        await logAlert('early_buy', earlyKey, text, tweetId ?? undefined, {
          poolAddress: watched.poolAddress, volumeM5, pct,
        });
        console.log(`[token-stream] Early buy: $${tokenSymbol} ${pct.toFixed(0)}% of liq`);
      }
    }
  }
}

async function pollWatchedPools(): Promise<void> {
  const now = Date.now();
  for (const [addr, watched] of _pools.entries()) {
    if (now - watched.detectedAt > MAX_WATCH_MS) {
      _pools.delete(addr);
      continue;
    }
    if (watched.alerted) continue;
    try {
      await checkPool(watched);
    } catch (err) {
      console.error(`[token-stream] checkPool error:`, err instanceof Error ? err.message : err);
    }
  }
}

export function startTokenStream(ws: RpcWs): void {
  const handle = (fn: (log: Log) => void) => (result: unknown) => {
    try { fn(result as Log); } catch { /* ignore bad log */ }
  };

  // V2 PairCreated — catches Uniswap V2, SushiSwap, BaseSwap V2, PancakeSwap V2, all V2 forks
  ws.subscribe({ topics: [UNISWAP_V2_PAIR_CREATED] }, handle(onV2PairCreated));

  // V3 PoolCreated — catches Uniswap V3, PancakeSwap V3, BaseSwap V3, Aerodrome CL, all V3 forks
  ws.subscribe({ topics: [UNISWAP_V3_POOL_CREATED] }, handle(onV3PoolCreated));

  // Aerodrome/Velodrome V1 — unique event signature with `bool stable` param
  ws.subscribe({ topics: [AERODROME_PAIR_CREATED] }, handle(onAerodromePairCreated));

  // V4 Initialize — singleton PoolManager, filter by contract address
  ws.subscribe(
    { address: UNISWAP_V4_POOL_MANAGER, topics: [UNISWAP_V4_INITIALIZE] },
    handle(onV4Initialize),
  );

  // Poll accumulated volume for watched pools every 2 min
  setInterval(() => {
    pollWatchedPools().catch(err =>
      console.error('[token-stream] poll error:', err instanceof Error ? err.message : err),
    );
  }, VOLUME_POLL_MS);

  console.log('[token-stream] Watching ALL new pools on Base:');
  console.log('  → Uniswap V2 + all V2 forks (SushiSwap, BaseSwap, PancakeSwap V2...)');
  console.log('  → Uniswap V3 + all V3 forks (PancakeSwap V3, BaseSwap V3, Aerodrome CL...)');
  console.log('  → Aerodrome / Velodrome V1');
  console.log('  → Uniswap V4 (singleton PoolManager)');
}

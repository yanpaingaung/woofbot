function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`[alert-service] Missing required env var: ${name}`);
  return val;
}

export const config = {
  // Supabase
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceKey: required('SUPABASE_SERVICE_KEY'),

  // Twitter OAuth 1.0a (same credentials as base-bot)
  xAppKey: required('X_APP_KEY'),
  xAppSecret: required('X_APP_SECRET'),
  xAccessToken: required('X_ACCESS_TOKEN'),
  xAccessSecret: required('X_ACCESS_SECRET'),

  // Base RPC (Alchemy key from base-analytics-mcp)
  baseRpcUrl: process.env.BASE_RPC_URL ?? 'https://mainnet.base.org',

  // BaseScan API (for holder count / holder growth)
  basescanApiKey: process.env.BASESCAN_API_KEY ?? '',

  // Alert thresholds
  whaleUsdThreshold: Number(process.env.WHALE_USD_THRESHOLD ?? 50_000),
  newTokenLiquidityMin: Number(process.env.NEW_TOKEN_LIQUIDITY_MIN ?? 10_000),
  newTokenBuyThreshold: Number(process.env.NEW_TOKEN_BUY_THRESHOLD ?? 30_000),

  // Wallets to track from env (DB tracked_wallets table is the primary source)
  trackedWalletsEnv: (process.env.TRACKED_WALLETS ?? '')
    .split(',')
    .map(w => w.trim().toLowerCase())
    .filter(Boolean),

  // Poll intervals (ms)
  whalePollMs: Number(process.env.WHALE_POLL_MS ?? 60_000),
  walletPollMs: Number(process.env.WALLET_POLL_MS ?? 90_000),
  tokenPollMs: Number(process.env.TOKEN_POLL_MS ?? 300_000),

  // Safety: default to dry-run. Set ALERT_DRY_RUN=false to actually post.
  dryRun: process.env.ALERT_DRY_RUN !== 'false',

  dedupTtlHours: Number(process.env.DEDUP_TTL_HOURS ?? 24),
};

// Tokens to ignore in all alerts — we want meme/alt coins, not blue-chips
export const EXCLUDED_TOKEN_SYMBOLS = new Set([
  'WETH', 'ETH', 'USDC', 'USDT', 'DAI', 'FRAX', 'LUSD',
  'CBETH', 'WSTETH', 'RETH', 'WEETH', 'EZETH',
  'WBTC', 'BTC', 'TBTC', 'CBBTC',
  'USDBC', 'USDB', 'SUSD', 'CRVUSD', 'EURC',
]);

// Lowercase Base token addresses for the same set
export const EXCLUDED_TOKEN_ADDRESSES = new Set([
  '0x4200000000000000000000000000000000000006', // WETH
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22', // cbETH
  '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452', // wstETH
  '0x04c0599ae5a44757c0af6f9ec3b93da8976c150a', // weETH
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', // cbBTC
]);

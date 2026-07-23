// All tweet generators. No AI — pure string templates.
// Every output must stay ≤ 280 characters.

function fmtUsd(usd: number): string {
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(1)}B`;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${usd.toFixed(2)}`;
}

function fmtPct(pct: number): string {
  return `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`;
}

function fmtPrice(price: number): string {
  if (price === 0) return '—';
  if (price < 0.000001) return price.toExponential(2);
  if (price < 0.0001) return price.toPrecision(3);
  if (price < 1) return price.toPrecision(4);
  return price.toFixed(2);
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function whaleAlertTweet(opts: {
  kind: 'buy' | 'sell';
  tokenSymbol: string;
  amountUsd: number;
  price: number;
  poolName: string;
  dexId: string;
  buyerAddress?: string;
  tokenAddress?: string;
}): string {
  const emoji = opts.kind === 'buy' ? '🟢' : '🔴';
  const lines = [
    `🐋 WHALE ALERT | Base`,
    ``,
    `${emoji} ${opts.kind.toUpperCase()} $${opts.tokenSymbol} • ${fmtUsd(opts.amountUsd)}`,
    `Pool: ${opts.poolName}`,
    `Price: $${fmtPrice(opts.price)}`,
    `DEX: ${opts.dexId}`,
  ];
  if (opts.buyerAddress) lines.push(`Buyer: ${shortAddr(opts.buyerAddress)}`);
  if (opts.tokenAddress) lines.push(`CA: ${opts.tokenAddress}`);
  lines.push(``, `#Base #DeFi #WhaleAlert`);
  return lines.join('\n');
}

export function walletAlertTweet(opts: {
  kind: 'buy' | 'sell' | 'new_position' | 'exit';
  walletAddress: string;
  walletLabel?: string;
  tokenSymbol: string;
  amountUsd: number;
  price: number;
  tokenAddress?: string;
}): string {
  const actions: Record<string, string> = {
    buy: '🟢 BOUGHT',
    sell: '🔴 SOLD',
    new_position: '🆕 NEW POSITION',
    exit: '🚪 EXITED',
  };
  const label = opts.walletLabel ?? shortAddr(opts.walletAddress);
  const lines = [
    `👁️ SMART WALLET | Base`,
    ``,
    `${actions[opts.kind]} $${opts.tokenSymbol}`,
    `Wallet: ${label}`,
    `Amount: ${fmtUsd(opts.amountUsd)}`,
    `Price: $${fmtPrice(opts.price)}`,
  ];
  if (opts.tokenAddress) lines.push(`CA: ${opts.tokenAddress}`);
  lines.push(``, `#Base #SmartMoney`);
  return lines.join('\n');
}

export function coordinatedWalletsTweet(opts: {
  walletAddresses: string[];
  walletLabels: string[];
  tokenSymbol: string;
  totalAmountUsd: number;
}): string {
  const shown = opts.walletLabels.slice(0, 3).join(', ');
  const extra = opts.walletLabels.length > 3 ? ` +${opts.walletLabels.length - 3}` : '';
  return [
    `🚨 COORDINATED BUY | Base`,
    ``,
    `${opts.walletAddresses.length} tracked wallets bought $${opts.tokenSymbol}`,
    `Wallets: ${shown}${extra}`,
    `Combined: ${fmtUsd(opts.totalAmountUsd)}`,
    ``,
    `#Base #SmartMoney #Coordinated`,
  ].join('\n');
}

export function newTokenTweet(opts: {
  tokenName: string;
  tokenSymbol: string;
  dexId: string;
  liquidityUsd: number;
  totalBuyUsd: number;
  poolAgeMin?: number;
  tokenAddress?: string;
}): string {
  const age =
    opts.poolAgeMin === undefined ? 'Just deployed'
    : opts.poolAgeMin < 60 ? `${opts.poolAgeMin}m ago`
    : `${Math.floor(opts.poolAgeMin / 60)}h ago`;

  const lines = [
    `🆕 NEW TOKEN | Base`,
    ``,
    `${opts.tokenName} ($${opts.tokenSymbol})`,
    `Deployed: ${age}`,
    `Total Buys: ${fmtUsd(opts.totalBuyUsd)}`,
    `Liquidity: ${fmtUsd(opts.liquidityUsd)}`,
    `DEX: ${opts.dexId}`,
  ];
  if (opts.tokenAddress) lines.push(`CA: ${opts.tokenAddress}`);
  lines.push(``, `#Base #NewToken #DeFi`);
  return lines.join('\n');
}

export function largeEarlyBuyTweet(opts: {
  tokenSymbol: string;
  buyerAddress?: string;
  amountUsd: number;
  liquidityUsd: number;
  pctOfLiquidity: number;
}): string {
  const lines = [
    `⚡ LARGE EARLY BUY | Base`,
    ``,
    `$${opts.tokenSymbol}: ${fmtUsd(opts.amountUsd)} (${opts.pctOfLiquidity.toFixed(0)}% of liq)`,
  ];
  if (opts.buyerAddress) lines.push(`Buyer: ${shortAddr(opts.buyerAddress)}`);
  lines.push(`Pool Liq: ${fmtUsd(opts.liquidityUsd)}`, ``, `#Base #EarlyBuy #DeFi`);
  return lines.join('\n');
}

export function holderGrowthTweet(opts: {
  tokenSymbol: string;
  tokenName: string;
  holderCount: number;
  prevHolderCount: number;
  growthPct: number;
  liquidityUsd: number;
}): string {
  return [
    `📈 HOLDER GROWTH | Base`,
    ``,
    `$${opts.tokenSymbol} (${opts.tokenName})`,
    `Holders: ${opts.prevHolderCount} → ${opts.holderCount} (+${opts.growthPct.toFixed(0)}%)`,
    `Pool Liq: ${fmtUsd(opts.liquidityUsd)}`,
    ``,
    `#Base #DeFi #NewToken`,
  ].join('\n');
}


import { EXCLUDED_TOKEN_SYMBOLS, EXCLUDED_TOKEN_ADDRESSES } from '../config.js';
import {
  getTrackedWallets,
  upsertWalletPosition,
  getWalletsHoldingToken,
  logAlert,
} from '../db.js';
import { getTokenPairs } from '../sources/dexscreener.js';
import { isSafeToken } from '../sources/goplus.js';
import { walletAlertTweet, coordinatedWalletsTweet } from '../templates.js';
import { isDuplicate, markSeen } from '../dedup.js';
import { postTweet } from '../twitter.js';
import type { RpcWs } from './ws.js';

// ERC-20 Transfer(address indexed from, address indexed to, uint256 value)
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MIN_ALERT_USD = 50;

interface Log {
  address: string; // token contract
  topics: string[];
  data: string;    // uint256 transfer value
  transactionHash: string;
}

function addrFromTopic(topic: string): string {
  return ('0x' + topic.slice(-40)).toLowerCase();
}

// Pad wallet address to a 32-byte log topic for filtering
function padAddr(addr: string): string {
  return '0x' + addr.replace('0x', '').toLowerCase().padStart(64, '0');
}

async function onTransfer(
  log: Log,
  walletSet: Set<string>,
  walletLabels: Map<string, string | undefined>,
): Promise<void> {
  if (log.topics.length < 3) return;

  const from = addrFromTopic(log.topics[1]);
  const to = addrFromTopic(log.topics[2]);
  const tokenAddr = log.address.toLowerCase();

  const isBuy = walletSet.has(to);
  const isSell = walletSet.has(from);
  if (!isBuy && !isSell) return;

  const walletAddr = isBuy ? to : from;
  const kind = isBuy ? 'buy' : 'sell';

  const key = `wallet:${walletAddr}:${log.transactionHash}:${kind}`;
  if (await isDuplicate(key)) return;

  if (EXCLUDED_TOKEN_ADDRESSES.has(tokenAddr)) return;
  if (!(await isSafeToken(tokenAddr))) return;

  // Get price + token metadata from DexScreener
  const pairs = await getTokenPairs(tokenAddr);
  const bestPair = pairs[0];
  if (!bestPair) return;

  const isBase = bestPair.baseToken.address.toLowerCase() === tokenAddr;
  const tokenSymbol = (isBase ? bestPair.baseToken.symbol : bestPair.quoteToken.symbol).toUpperCase();
  if (EXCLUDED_TOKEN_SYMBOLS.has(tokenSymbol)) return;

  const priceUsd = Number(bestPair.priceUsd ?? 0);

  // Calculate USD value from raw transfer amount (assume 18 decimals — correct for all meme coins)
  const rawValue = BigInt(log.data);
  const tokenAmount = Number(rawValue / BigInt(1e9)) / 1e9; // split to avoid precision loss
  const amountUsd = tokenAmount * priceUsd;
  if (amountUsd < MIN_ALERT_USD) return;

  let alertKind: 'buy' | 'sell' | 'new_position' | 'exit' = kind;
  if (isBuy) {
    const isNew = await upsertWalletPosition(walletAddr, tokenAddr, tokenSymbol);
    if (isNew) alertKind = 'new_position';
  }

  const text = walletAlertTweet({
    kind: alertKind,
    walletAddress: walletAddr,
    walletLabel: walletLabels.get(walletAddr),
    tokenSymbol,
    amountUsd,
    price: priceUsd,
    mcapUsd: bestPair.marketCap ?? undefined,
    tokenAddress: tokenAddr,
  });

  await markSeen(key);
  const tweetId = await postTweet(text);
  await logAlert('wallet', key, text, tweetId ?? undefined, {
    trader: walletAddr, tokenSymbol, tokenAddr, txHash: log.transactionHash, amountUsd,
  });
  console.log(`[wallet-stream] ${walletAddr.slice(0, 8)} ${alertKind} $${tokenSymbol} ~$${amountUsd.toFixed(0)}`);

  // Coordinated buy detection
  if (alertKind === 'new_position') {
    const recentHolders = await getWalletsHoldingToken(tokenAddr);
    const trackedHolders = recentHolders.filter(h => walletSet.has(h));
    if (trackedHolders.length >= 2) {
      const window4h = Math.floor(Date.now() / (4 * 60 * 60 * 1000));
      const coordKey = `coord:${[...trackedHolders].sort().join(':')}:${tokenAddr}:${window4h}`;
      if (!(await isDuplicate(coordKey))) {
        const labels = trackedHolders.map(
          h => walletLabels.get(h) ?? `${h.slice(0, 6)}…${h.slice(-4)}`,
        );
        const coordText = coordinatedWalletsTweet({
          walletAddresses: trackedHolders,
          walletLabels: labels,
          tokenSymbol,
          totalAmountUsd: amountUsd,
          mcapUsd: bestPair.marketCap ?? undefined,
          tokenAddress: tokenAddr,
        });
        await markSeen(coordKey);
        const coordId = await postTweet(coordText);
        await logAlert('coordinated', coordKey, coordText, coordId ?? undefined, {
          tokenAddr, tokenSymbol, trackedHolders,
        });
        console.log(`[wallet-stream] Coordinated: ${trackedHolders.length} wallets in $${tokenSymbol}`);
      }
    }
  }
}

export async function startWalletStream(ws: RpcWs): Promise<void> {
  const wallets = await getTrackedWallets();
  if (wallets.length === 0) {
    console.log('[wallet-stream] No tracked wallets — skipping');
    return;
  }

  const walletSet = new Set(wallets.map(w => w.address));
  const walletLabels = new Map(wallets.map(w => [w.address, w.label]));
  const paddedAddrs = wallets.map(w => padAddr(w.address));

  const handler = (result: unknown) => {
    onTransfer(result as Log, walletSet, walletLabels).catch(err =>
      console.error('[wallet-stream] error:', err instanceof Error ? err.message : err),
    );
  };

  // Incoming transfers TO tracked wallets (buys)
  ws.subscribe({ topics: [TRANSFER_TOPIC, null, paddedAddrs] }, handler);

  // Outgoing transfers FROM tracked wallets (sells)
  ws.subscribe({ topics: [TRANSFER_TOPIC, paddedAddrs, null] }, handler);

  console.log(`[wallet-stream] Tracking ${wallets.length} wallet(s) in real-time`);
  wallets.forEach(w => console.log(`  → ${w.label ?? w.address}`));
}

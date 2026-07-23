import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from './config.js';

let _client: SupabaseClient | null = null;

export function getDb(): SupabaseClient {
  if (!_client) {
    _client = createClient(config.supabaseUrl, config.supabaseServiceKey);
  }
  return _client;
}

export async function getTrackedWallets(): Promise<Array<{ address: string; label?: string }>> {
  const db = getDb();
  const { data } = await db
    .from('tracked_wallets')
    .select('address, label')
    .eq('active', true);

  const fromDb = (data ?? []).map((r: { address: string; label: string | null }) => ({
    address: r.address.toLowerCase(),
    label: r.label ?? undefined,
  }));
  const fromEnv = config.trackedWalletsEnv.map(a => ({ address: a }));

  // Merge env + DB, env label wins if both define the same address
  const map = new Map<string, { address: string; label?: string }>();
  for (const w of [...fromDb, ...fromEnv]) map.set(w.address, w);
  return Array.from(map.values());
}

// Returns true if this is the first time we've seen this wallet+token pair
export async function upsertWalletPosition(
  walletAddress: string,
  tokenAddress: string,
  tokenSymbol: string,
): Promise<boolean> {
  const db = getDb();
  const { data: existing } = await db
    .from('wallet_positions')
    .select('id')
    .eq('wallet_address', walletAddress)
    .eq('token_address', tokenAddress)
    .maybeSingle();

  if (existing) {
    await db
      .from('wallet_positions')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', (existing as { id: number }).id);
    return false;
  }

  await db.from('wallet_positions').insert({
    wallet_address: walletAddress,
    token_address: tokenAddress,
    token_symbol: tokenSymbol,
  });
  return true;
}

// Returns all tracked wallets that have touched this token in the last 4 hours
export async function getWalletsHoldingToken(tokenAddress: string): Promise<string[]> {
  const db = getDb();
  const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const { data } = await db
    .from('wallet_positions')
    .select('wallet_address')
    .eq('token_address', tokenAddress)
    .gte('last_seen_at', cutoff);
  return (data ?? []).map((r: { wallet_address: string }) => r.wallet_address);
}

export async function logAlert(
  alertType: string,
  alertKey: string,
  tweetText: string,
  tweetId?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const db = getDb();
  await db.from('alert_log').insert({
    alert_type: alertType,
    alert_key: alertKey,
    tweet_text: tweetText,
    tweet_id: tweetId ?? null,
    metadata: metadata ?? null,
  });
}

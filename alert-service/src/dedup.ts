import { getDb } from './db.js';
import { config } from './config.js';

export async function isDuplicate(key: string): Promise<boolean> {
  const db = getDb();
  const cutoff = new Date(Date.now() - config.dedupTtlHours * 60 * 60 * 1000).toISOString();
  const { data } = await db
    .from('alert_dedup')
    .select('id')
    .eq('alert_key', key)
    .gte('created_at', cutoff)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

let _pruneCounter = 0;

export async function markSeen(key: string): Promise<void> {
  const db = getDb();
  await db
    .from('alert_dedup')
    .upsert({ alert_key: key, created_at: new Date().toISOString() }, { onConflict: 'alert_key' });

  // Prune expired entries every 50 calls to avoid hammering the DB
  if (++_pruneCounter % 50 === 0) {
    const cutoff = new Date(Date.now() - config.dedupTtlHours * 60 * 60 * 1000).toISOString();
    await db.from('alert_dedup').delete().lt('created_at', cutoff);
  }
}

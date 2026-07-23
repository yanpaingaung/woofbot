const BASE_URL = 'https://api.gopluslabs.io/api/v1';
const CHAIN_ID = '8453'; // Base

interface GoPlusResult {
  is_honeypot?: string;
  cannot_sell_all?: string;
  sell_tax?: string;
  buy_tax?: string;
  transfer_pausable?: string;
  trading_cooldown?: string;
}

// Cache results to avoid redundant calls — token risk doesn't change often
const _cache = new Map<string, { safe: boolean; fetchedAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

export async function isSafeToken(tokenAddress: string): Promise<boolean> {
  const addr = tokenAddress.toLowerCase();
  const cached = _cache.get(addr);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.safe;
  }

  try {
    const res = await fetch(
      `${BASE_URL}/token_security/${CHAIN_ID}?contract_addresses=${addr}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return true; // fail open — don't block alert if API is down

    const data = await res.json() as { code: number; result: Record<string, GoPlusResult> };
    if (data.code !== 1) return true;

    const result = data.result[addr];
    if (!result) return true;

    const unsafe =
      result.is_honeypot === '1' ||
      result.cannot_sell_all === '1' ||
      Number(result.sell_tax ?? 0) > 50 || // > 50% sell tax = effectively unsellable
      result.transfer_pausable === '1';

    _cache.set(addr, { safe: !unsafe, fetchedAt: Date.now() });

    if (unsafe) {
      console.log(
        `[goplus] Honeypot detected: ${addr} — honeypot=${result.is_honeypot} sellTax=${result.sell_tax} cannotSellAll=${result.cannot_sell_all}`,
      );
    }
    return !unsafe;
  } catch {
    return true; // fail open
  }
}

import { config } from '../config.js';

const BASE_URL = 'https://api.basescan.org/api';

async function basescanFetch<T>(params: Record<string, string>): Promise<T | null> {
  const qs = new URLSearchParams({ ...params, apikey: config.basescanApiKey });
  try {
    const res = await fetch(`${BASE_URL}?${qs}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = await res.json() as { status: string; result: T };
    if (json.status !== '1') return null;
    return json.result;
  } catch {
    return null;
  }
}

export async function getHolderCount(tokenAddress: string): Promise<number> {
  const result = await basescanFetch<string>({
    module: 'token',
    action: 'tokenholdercount',
    contractaddress: tokenAddress,
  });
  return result ? parseInt(result, 10) : 0;
}

export async function getTopHolders(
  tokenAddress: string,
  limit = 10,
): Promise<Array<{ TokenHolderAddress: string; TokenHolderQuantity: string }>> {
  return await basescanFetch<Array<{ TokenHolderAddress: string; TokenHolderQuantity: string }>>({
    module: 'token',
    action: 'tokenholderlist',
    contractaddress: tokenAddress,
    page: '1',
    offset: String(limit),
  }) ?? [];
}

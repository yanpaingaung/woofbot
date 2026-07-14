/**
 * Retry an async fn with exponential backoff on 429 (rate limit) responses.
 * Other errors are thrown immediately.
 */
export async function withRetry(fn, { maxAttempts = 4, baseDelayMs = 5000 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit =
        err?.status === 429 ||
        err?.code === 429 ||
        (err?.message ?? "").includes("429") ||
        (err?.message ?? "").toLowerCase().includes("rate limit");

      if (!isRateLimit || attempt === maxAttempts) throw err;

      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`[retry] Rate limited (attempt ${attempt}/${maxAttempts}), waiting ${delay}ms…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

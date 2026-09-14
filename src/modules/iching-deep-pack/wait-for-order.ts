import type { OrderLike } from "./types";

export type FetchOrderSnapshot = {
  order: OrderLike | null;
  checkoutId?: string | null;
};

export type DeepPackPollConfig = {
  attempts: number;
  baseDelayMs: number;
};

export function getDeepPackPollConfig(env: NodeJS.ProcessEnv = process.env): DeepPackPollConfig {
  const attempts = Number(env.ICHING_DEEP_PACK_POLL_ATTEMPTS ?? "5");
  const baseDelayMs = Number(env.ICHING_DEEP_PACK_POLL_BASE_MS ?? "2000");
  return {
    attempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 5,
    baseDelayMs: Number.isFinite(baseDelayMs) && baseDelayMs >= 0 ? Math.floor(baseDelayMs) : 2000,
  };
}

export async function waitForSaleorOrder(params: {
  fetchOrder: () => Promise<FetchOrderSnapshot>;
  sleep?: (ms: number) => Promise<void>;
  attempts: number;
  baseDelayMs: number;
}): Promise<FetchOrderSnapshot | null> {
  const sleep =
    params.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; attempt <= params.attempts; attempt += 1) {
    const snapshot = await params.fetchOrder();
    if (snapshot.order) {
      return snapshot;
    }
    if (attempt < params.attempts) {
      const delay = params.baseDelayMs * 2 ** (attempt - 1);
      await sleep(delay);
    }
  }

  return null;
}

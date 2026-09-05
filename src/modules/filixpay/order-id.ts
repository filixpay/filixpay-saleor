const PREFIX = "SALEOR-";

/**
 * Normalize Filix list order id to `SALEOR-{transactionToken}`.
 * Accepts bare uuid or already-prefixed ids.
 */
export function normalizeFilixOrderId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("filixOrderId is required");
  }
  if (trimmed.startsWith(PREFIX)) {
    return trimmed;
  }
  return `${PREFIX}${trimmed}`;
}

/**
 * Extract Saleor transaction.token from a Filix order id.
 */
export function parseTransactionToken(filixOrderId: string): string {
  const normalized = normalizeFilixOrderId(filixOrderId);
  const token = normalized.slice(PREFIX.length).trim();
  if (!token) {
    throw new Error("filixOrderId is missing transaction token");
  }
  return token;
}

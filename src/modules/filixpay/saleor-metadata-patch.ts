/**
 * Resolve FilixPay order UUID for PATCH saleor-metadata.
 * Commerce initialize sets Saleor transaction.pspReference = FilixPay orderId (UUID).
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isFilixPayOrderUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export type SaleorMetadataPatchTarget = {
  filixPayOrderId: string;
  saleorOrderId: string;
  saleorOrderNumber?: string;
};

/**
 * Build PATCH target from Saleor transaction after payment success.
 * Returns null when order linkage is incomplete (caller should skip + log).
 */
export function resolveSaleorMetadataPatchTarget(input: {
  pspReference?: string | null;
  saleorOrderId?: string | null;
  saleorOrderNumber?: string | null;
}): SaleorMetadataPatchTarget | null {
  const filixPayOrderId = input.pspReference?.trim();
  const saleorOrderId = input.saleorOrderId?.trim();

  if (!isFilixPayOrderUuid(filixPayOrderId) || !saleorOrderId) {
    return null;
  }

  const saleorOrderNumber = input.saleorOrderNumber?.trim();
  return {
    filixPayOrderId,
    saleorOrderId,
    ...(saleorOrderNumber ? { saleorOrderNumber } : {}),
  };
}

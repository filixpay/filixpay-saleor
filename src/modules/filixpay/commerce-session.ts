import type { TransactionInitializeSessionEventFragment } from "@/generated/graphql";

export type FilixPayCommercePaymentSessionLine = {
  saleorProductId: string;
  saleorVariantId: string;
  quantity: number;
};

export type FilixPayCommercePaymentSessionInput = {
  saleorCheckoutId: string;
  saleorTransactionToken: string;
  amount: number;
  currency: string;
  returnUrl: string;
  buyerEmail: string;
  country?: string;
  lines: FilixPayCommercePaymentSessionLine[];
};

type CheckoutSourceObject = Extract<
  NonNullable<TransactionInitializeSessionEventFragment["sourceObject"]>,
  { __typename?: "Checkout" }
>;

function readReturnUrl(data: unknown): string | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }

  const value = (data as Record<string, unknown>).returnUrl;

  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseAmount(amount: unknown): number {
  if (typeof amount === "number" && Number.isFinite(amount)) {
    return amount;
  }

  if (typeof amount === "string" && amount.trim()) {
    const parsed = Number(amount);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  throw new Error("FilixPay commerce checkout requires a numeric payment amount");
}

function mapCheckoutLines(
  checkout: CheckoutSourceObject
): FilixPayCommercePaymentSessionLine[] {
  const lines = checkout.lines ?? [];

  return lines.map((line, index) => {
    const saleorVariantId = line.variant?.id?.trim();
    const saleorProductId = line.variant?.product?.id?.trim();
    const quantity = line.quantity;

    if (!saleorVariantId || !saleorProductId) {
      throw new Error(`Checkout line ${index + 1} is missing Saleor product or variant id`);
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new Error(`Checkout line ${index + 1} must have quantity >= 1`);
    }

    return {
      saleorProductId,
      saleorVariantId,
      quantity,
    };
  });
}

/**
 * Maps Saleor TRANSACTION_INITIALIZE_SESSION payload to FilixPay commerce checkout input.
 * Returns null when sourceObject is not a Checkout — callers must fail closed (no legacy /orders).
 */
export function extractCommercePaymentSessionInput(
  payload: TransactionInitializeSessionEventFragment
): FilixPayCommercePaymentSessionInput | null {
  const sourceObject = payload.sourceObject;
  if (!sourceObject || sourceObject.__typename !== "Checkout") {
    return null;
  }

  const checkout = sourceObject;
  const saleorCheckoutId = checkout.token?.trim();
  const saleorTransactionToken = payload.transaction.token?.trim();
  const buyerEmail = checkout.email?.trim();
  const returnUrl = readReturnUrl(payload.data);
  const lines = mapCheckoutLines(checkout);

  if (!saleorCheckoutId) {
    throw new Error("Checkout token is required for FilixPay commerce checkout");
  }

  if (!saleorTransactionToken) {
    throw new Error("Saleor transaction token is required for FilixPay commerce checkout");
  }

  if (!buyerEmail) {
    throw new Error("Checkout buyer email is required for FilixPay commerce checkout");
  }

  if (!returnUrl) {
    throw new Error("returnUrl is required in webhook data for FilixPay commerce checkout");
  }

  if (lines.length !== 1) {
    throw new Error("FilixPay commerce checkout V1 requires exactly one checkout line");
  }

  if (lines[0].quantity !== 1) {
    throw new Error("FilixPay commerce checkout V1 requires line quantity 1");
  }

  return {
    saleorCheckoutId,
    saleorTransactionToken,
    amount: parseAmount(payload.action.amount),
    currency: payload.action.currency,
    returnUrl,
    buyerEmail,
    country: checkout.billingAddress?.country?.code?.trim() || undefined,
    lines,
  };
}

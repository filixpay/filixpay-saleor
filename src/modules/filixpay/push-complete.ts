import { normalizeFilixOrderId, parseTransactionToken } from "./order-id";
import type {
  PushCompleteCheckoutSnapshot,
  PushCompleteDeps,
  PushCompleteErrorCode,
  PushCompleteResult,
  PushCompleteTransactionSnapshot,
} from "./push-complete.types";

export function isCheckoutPaidForCompletion(
  checkout: PushCompleteCheckoutSnapshot | null | undefined
): boolean {
  if (!checkout) {
    return false;
  }
  return checkout.chargeStatus === "FULL" || checkout.authorizeStatus === "FULL";
}

function defaultIsTransactionPaid(transaction: PushCompleteTransactionSnapshot | null): boolean {
  if (!transaction) {
    return false;
  }
  const charged = transaction.chargedAmount?.amount;
  const authorized = transaction.authorizedAmount?.amount;
  return (
    (typeof charged === "number" && Number.isFinite(charged) && charged > 0) ||
    (typeof authorized === "number" && Number.isFinite(authorized) && authorized > 0)
  );
}

function fail(
  filixOrderId: string,
  code: PushCompleteErrorCode,
  message: string,
  paymentSynced: boolean
): PushCompleteResult {
  return {
    status: "failed",
    filixOrderId,
    steps: { paymentSynced, checkoutCompleted: false },
    error: { code, message },
  };
}

export function mapCheckoutCompleteErrorCode(saleorCode: string | null | undefined): PushCompleteErrorCode {
  switch (saleorCode) {
    case "INSUFFICIENT_STOCK":
      return "INSUFFICIENT_STOCK";
    case "CHECKOUT_NOT_FULLY_PAID":
      return "CHECKOUT_NOT_FULLY_PAID";
    default:
      return "INTERNAL";
  }
}

function isPaid(
  transaction: PushCompleteTransactionSnapshot | null,
  deps: PushCompleteDeps
): boolean {
  if (!transaction) {
    return false;
  }
  if (isCheckoutPaidForCompletion(transaction.checkout)) {
    return true;
  }
  const check = deps.isTransactionPaid ?? defaultIsTransactionPaid;
  return check(transaction);
}

/**
 * Paid-but-no-order recovery: lookup → optional payment sync → checkoutComplete.
 * Never charges the customer; sync must reuse Filix/Saleor amounts only.
 */
export async function pushCompletePaidCheckout(
  filixOrderIdRaw: string,
  deps: PushCompleteDeps
): Promise<PushCompleteResult> {
  let filixOrderId: string;
  let token: string;

  try {
    filixOrderId = normalizeFilixOrderId(filixOrderIdRaw);
    token = parseTransactionToken(filixOrderId);
  } catch (err) {
    return fail(
      String(filixOrderIdRaw ?? "").trim() || "SALEOR-",
      "NOT_ELIGIBLE",
      err instanceof Error ? err.message : "Invalid filixOrderId",
      false
    );
  }

  let paymentSynced = false;

  try {
    let tx = await deps.lookupTransaction(token);
    if (!tx) {
      return fail(filixOrderId, "NOT_ELIGIBLE", "Saleor transaction not found", paymentSynced);
    }

    if (tx.order) {
      return {
        status: "already_completed",
        filixOrderId,
        saleorOrderNumber: String(tx.order.number),
        saleorOrderId: tx.order.id,
        steps: { paymentSynced: false, checkoutCompleted: false },
      };
    }

    if (!isPaid(tx, deps)) {
      await deps.syncPayment(tx);
      paymentSynced = true;
      tx = await deps.lookupTransaction(token);
      if (!isPaid(tx, deps)) {
        return fail(
          filixOrderId,
          "PAYMENT_NOT_SETTLED",
          "Payment not settled in Saleor after sync",
          paymentSynced
        );
      }
    }

    if (!tx?.checkout?.id) {
      return fail(filixOrderId, "CHECKOUT_GONE", "Checkout no longer available", paymentSynced);
    }

    const complete = await deps.checkoutComplete(tx.checkout.id);
    if (complete.errors && complete.errors.length > 0) {
      const first = complete.errors[0];
      const code = mapCheckoutCompleteErrorCode(first.code);
      return fail(filixOrderId, code, first.message?.trim() || code, paymentSynced);
    }

    if (!complete.order) {
      return fail(filixOrderId, "INTERNAL", "checkoutComplete returned no order", paymentSynced);
    }

    return {
      status: "completed",
      filixOrderId,
      saleorOrderNumber: String(complete.order.number),
      saleorOrderId: complete.order.id,
      steps: { paymentSynced, checkoutCompleted: true },
    };
  } catch (err) {
    return fail(
      filixOrderId,
      "INTERNAL",
      err instanceof Error ? err.message : "Unexpected push-complete failure",
      paymentSynced
    );
  }
}

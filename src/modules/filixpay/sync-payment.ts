import { normalizeFilixOrderId, parseTransactionToken } from "./order-id";
import { isCheckoutPaidForCompletion } from "./push-complete";
import type { PushCompleteTransactionSnapshot } from "./push-complete.types";
import type { SyncPaymentDeps, SyncPaymentResult } from "./sync-payment.types";

function defaultIsAlreadyPaid(transaction: PushCompleteTransactionSnapshot): boolean {
  if (isCheckoutPaidForCompletion(transaction.checkout)) {
    return true;
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
  status: Extract<SyncPaymentResult["status"], "failed" | "amount_mismatch">,
  message: string
): SyncPaymentResult {
  return {
    status,
    filixOrderId,
    error: { message },
  };
}

/**
 * Pull Filix order status and, when paid, report CHARGE_SUCCESS to Saleor.
 * Does not call checkoutComplete — storefront owns order creation on refresh.
 */
export async function syncPaidFilixOrderToSaleor(
  filixOrderIdRaw: string,
  deps: SyncPaymentDeps
): Promise<SyncPaymentResult> {
  let filixOrderId: string;
  let token: string;

  try {
    filixOrderId = normalizeFilixOrderId(filixOrderIdRaw);
    token = parseTransactionToken(filixOrderId);
  } catch (err) {
    return fail(
      String(filixOrderIdRaw ?? "").trim() || "SALEOR-",
      "failed",
      err instanceof Error ? err.message : "Invalid filixOrderId"
    );
  }

  try {
    const transaction = await deps.lookupTransaction(token);
    if (!transaction) {
      return {
        status: "not_found",
        filixOrderId,
        error: { message: "Saleor transaction not found" },
      };
    }

    const isPaid = deps.isAlreadyPaid ?? defaultIsAlreadyPaid;
    if (isPaid(transaction)) {
      return {
        status: "already_paid",
        filixOrderId,
        saleorTransactionId: transaction.id,
        pspReference: transaction.pspReference ?? undefined,
      };
    }

    const paidLookup = await deps.fetchPaidOrder(filixOrderId);
    if (paidLookup.status === "not_paid") {
      return {
        status: "not_paid",
        filixOrderId,
        saleorTransactionId: transaction.id,
      };
    }

    const { order } = paidLookup;
    const checkoutAmount = transaction.checkout?.totalPrice?.gross?.amount;
    if (
      typeof checkoutAmount === "number" &&
      Number.isFinite(checkoutAmount) &&
      Math.abs(checkoutAmount - order.amount) > 0.009
    ) {
      return fail(
        filixOrderId,
        "amount_mismatch",
        `Filix paid amount ${order.amount} does not match Saleor checkout total ${checkoutAmount}`
      );
    }

    await deps.reportChargeSuccess({
      transaction,
      amount: order.amount,
      tradeNo: order.tradeNo,
      filixOrderId,
    });

    return {
      status: "synced",
      filixOrderId,
      saleorTransactionId: transaction.id,
      pspReference: order.tradeNo,
    };
  } catch (err) {
    return fail(
      filixOrderId,
      "failed",
      err instanceof Error ? err.message : "Unexpected sync-payment failure"
    );
  }
}

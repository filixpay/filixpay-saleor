import { NextApiRequest, NextApiResponse } from "next";
import { createLogger } from "@/lib/logger/create-logger";
import { createSyncPaymentDeps } from "@/modules/filixpay/sync-payment-deps";
import { syncPaidFilixOrderToSaleor } from "@/modules/filixpay/sync-payment";
import type { SyncPaymentResult } from "@/modules/filixpay/sync-payment.types";

function readPrivateSecret(req: NextApiRequest) {
  const header = req.headers["x-filixpay-private-secret"];
  if (typeof header === "string" && header.trim()) {
    return header.trim();
  }
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  return undefined;
}

function httpStatusForResult(result: SyncPaymentResult): number {
  switch (result.status) {
    case "synced":
    case "already_paid":
    case "not_paid":
      return 200;
    case "not_found":
      return 404;
    case "amount_mismatch":
      return 422;
    default:
      return 500;
  }
}

/**
 * Private sync-only recovery for storefront refresh.
 * Body: { filixOrderId: "SALEOR-…" | "{uuid}" }
 * Auth: shared secret via X-FilixPay-Private-Secret or Authorization: Bearer
 *
 * Does not call checkoutComplete — storefront owns order creation.
 */
export default async function syncPaymentHandler(req: NextApiRequest, res: NextApiResponse) {
  const logger = createLogger("private-sync-payment");

  if (req.method !== "POST") {
    return res.status(405).json({
      status: "failed",
      filixOrderId: "",
      error: { message: "Method not allowed" },
    } satisfies SyncPaymentResult);
  }

  const configuredSecret = process.env.FILIXPAY_PRIVATE_API_SECRET?.trim();
  if (!configuredSecret) {
    logger.error("FILIXPAY_PRIVATE_API_SECRET is not configured");
    return res.status(500).json({
      status: "failed",
      filixOrderId: "",
      error: { message: "Private API secret not configured" },
    } satisfies SyncPaymentResult);
  }

  const provided = readPrivateSecret(req);
  if (!provided || provided !== configuredSecret) {
    logger.warn("Unauthorized private sync-payment attempt");
    return res.status(403).json({
      status: "failed",
      filixOrderId: "",
      error: { message: "Forbidden" },
    } satisfies SyncPaymentResult);
  }

  const filixOrderId =
    typeof req.body?.filixOrderId === "string" ? req.body.filixOrderId : "";

  if (!filixOrderId.trim()) {
    return res.status(422).json({
      status: "failed",
      filixOrderId: "",
      error: { message: "filixOrderId is required" },
    } satisfies SyncPaymentResult);
  }

  try {
    const result = await syncPaidFilixOrderToSaleor(filixOrderId, createSyncPaymentDeps());
    logger.info("sync-payment finished", {
      status: result.status,
      filixOrderId: result.filixOrderId,
      saleorTransactionId: result.saleorTransactionId,
    });
    return res.status(httpStatusForResult(result)).json(result);
  } catch (err) {
    logger.error("sync-payment crashed", {
      errorName: err instanceof Error ? err.name : undefined,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      status: "failed",
      filixOrderId,
      error: {
        message: err instanceof Error ? err.message : "Unexpected error",
      },
    } satisfies SyncPaymentResult);
  }
}

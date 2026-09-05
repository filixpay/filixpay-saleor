import { NextApiRequest, NextApiResponse } from "next";
import { createLogger } from "@/lib/logger/create-logger";
import { createPushCompleteDeps } from "@/modules/filixpay/push-complete-deps";
import { pushCompletePaidCheckout } from "@/modules/filixpay/push-complete";
import type { PushCompleteResult } from "@/modules/filixpay/push-complete.types";

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

function httpStatusForResult(result: PushCompleteResult): number {
  if (result.status === "completed" || result.status === "already_completed") {
    return 200;
  }
  switch (result.error?.code) {
    case "FORBIDDEN":
      return 403;
    case "NOT_ELIGIBLE":
      return 422;
    case "PAYMENT_NOT_SETTLED":
    case "CHECKOUT_GONE":
    case "CHECKOUT_NOT_FULLY_PAID":
    case "INSUFFICIENT_STOCK":
      return 422;
    default:
      return 500;
  }
}

/**
 * Private recovery endpoint for filix-pay (server-to-server).
 * Body: { filixOrderId: "SALEOR-…" | "{uuid}" }
 * Auth: shared secret via X-FilixPay-Private-Secret or Authorization: Bearer
 */
export default async function pushCompleteHandler(req: NextApiRequest, res: NextApiResponse) {
  const logger = createLogger("private-push-complete");

  if (req.method !== "POST") {
    return res.status(405).json({
      status: "failed",
      filixOrderId: "",
      steps: { paymentSynced: false, checkoutCompleted: false },
      error: { code: "INTERNAL", message: "Method not allowed" },
    } satisfies PushCompleteResult);
  }

  const configuredSecret = process.env.FILIXPAY_PRIVATE_API_SECRET?.trim();
  if (!configuredSecret) {
    logger.error("FILIXPAY_PRIVATE_API_SECRET is not configured");
    return res.status(500).json({
      status: "failed",
      filixOrderId: "",
      steps: { paymentSynced: false, checkoutCompleted: false },
      error: { code: "INTERNAL", message: "Private API secret not configured" },
    } satisfies PushCompleteResult);
  }

  const provided = readPrivateSecret(req);
  if (!provided || provided !== configuredSecret) {
    logger.warn("Unauthorized private push-complete attempt");
    return res.status(403).json({
      status: "failed",
      filixOrderId: "",
      steps: { paymentSynced: false, checkoutCompleted: false },
      error: { code: "FORBIDDEN", message: "Forbidden" },
    } satisfies PushCompleteResult);
  }

  const filixOrderId =
    typeof req.body?.filixOrderId === "string" ? req.body.filixOrderId : "";

  if (!filixOrderId.trim()) {
    return res.status(422).json({
      status: "failed",
      filixOrderId: "",
      steps: { paymentSynced: false, checkoutCompleted: false },
      error: { code: "NOT_ELIGIBLE", message: "filixOrderId is required" },
    } satisfies PushCompleteResult);
  }

  try {
    const result = await pushCompletePaidCheckout(filixOrderId, createPushCompleteDeps());
    logger.info("push-complete finished", {
      status: result.status,
      filixOrderId: result.filixOrderId,
      errorCode: result.error?.code,
      steps: result.steps,
    });
    return res.status(httpStatusForResult(result)).json(result);
  } catch (err) {
    logger.error("push-complete crashed", {
      errorName: err instanceof Error ? err.name : undefined,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      status: "failed",
      filixOrderId,
      steps: { paymentSynced: false, checkoutCompleted: false },
      error: {
        code: "INTERNAL",
        message: err instanceof Error ? err.message : "Unexpected error",
      },
    } satisfies PushCompleteResult);
  }
}

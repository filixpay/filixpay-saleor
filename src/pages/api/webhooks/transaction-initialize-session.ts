import fs from "node:fs";
import path from "node:path";
import { createFilixPayCommercePaymentSession } from "@/modules/filixpay/client";
import { extractCommercePaymentSessionInput } from "@/modules/filixpay/commerce-session";

import { SaleorSyncWebhook } from "@saleor/app-sdk/handlers/next";
import { saleorApp } from "@/saleor-app";
import {
  TransactionFlowStrategyEnum,
  TransactionInitializeSessionDocument,
  TransactionInitializeSessionEventFragment,
} from "@/generated/graphql";
import { v7 as uuidv7 } from "uuid";
import { createLogger } from "@/lib/logger/create-logger";
import { wrapWithLoggerContext } from "@/lib/logger/logger-context";
import { withOtel } from "@/lib/otel/otel-wrapper";
import { loggerContext } from "@/logger-context";
import {
  TransactionSessionFailure,
  TransactionSessionSuccess,
} from "@/generated/app-webhooks-types/transaction-initialize-session";

export const transactionInitializeSessionWebhook =
  new SaleorSyncWebhook<TransactionInitializeSessionEventFragment>({
    name: "Transaction Initialize Session",
    webhookPath: "api/webhooks/transaction-initialize-session",
    event: "TRANSACTION_INITIALIZE_SESSION",
    apl: saleorApp.apl,
    query: TransactionInitializeSessionDocument,
  });

// #region agent log
function agentDebugLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>
) {
  const payload = {
    sessionId: "a3afbf",
    runId: "pre-fix",
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  fetch("http://127.0.0.1:7831/ingest/b078c2ef-9d88-4bed-aa48-04e9214be92e", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "a3afbf",
    },
    body: JSON.stringify(payload),
  }).catch(() => {});
  try {
    const line = `${JSON.stringify(payload)}\n`;
    for (const candidate of [
      path.join(process.cwd(), "debug-a3afbf.log"),
      path.join(process.cwd(), "..", "debug-a3afbf.log"),
      "/data/debug-a3afbf.log",
    ]) {
      try {
        fs.appendFileSync(candidate, line);
        break;
      } catch {
        /* try next path */
      }
    }
  } catch {
    /* ignore file log failures */
  }
}
// #endregion

export default wrapWithLoggerContext(
  withOtel(
    transactionInitializeSessionWebhook.createHandler(async (req, res, ctx) => {
      const logger = createLogger("transaction-initialize-session");

      const { payload } = ctx;
      const { actionType, amount } = payload.action;

      logger.info("Received transaction initialize webhook", { payload });
      // #region agent log
      agentDebugLog("A", "transaction-initialize-session.ts:entry", "webhook received", {
        actionType,
        amount,
        currency: payload.action.currency,
        sourceTypename: payload.sourceObject?.__typename ?? null,
        hasReturnUrl:
          !!payload.data &&
          typeof payload.data === "object" &&
          typeof (payload.data as { returnUrl?: unknown }).returnUrl === "string",
        checkoutEmail:
          payload.sourceObject?.__typename === "Checkout"
            ? Boolean(payload.sourceObject.email)
            : false,
        lineCount:
          payload.sourceObject?.__typename === "Checkout"
            ? (payload.sourceObject.lines?.length ?? 0)
            : null,
      });
      // #endregion

      try {
        const commerceInput = extractCommercePaymentSessionInput(payload);
        // #region agent log
        agentDebugLog("B", "transaction-initialize-session.ts:extract", "commerce input extracted", {
          ok: Boolean(commerceInput),
          lineCount: commerceInput?.lines.length ?? null,
          hasProductName: Boolean(commerceInput?.lines[0]?.productName),
          hasUnitPrice: typeof commerceInput?.lines[0]?.unitPrice === "number",
          amount: commerceInput?.amount ?? null,
        });
        // #endregion
        if (!commerceInput) {
          throw new Error(
            "FilixPay Saleor checkout requires Checkout sourceObject with product lines; legacy POST /orders is disabled"
          );
        }

        const checkout = await createFilixPayCommercePaymentSession(commerceInput);
        // #region agent log
        agentDebugLog("C", "transaction-initialize-session.ts:filix-ok", "filix session created", {
          hasRedirectUrl: Boolean(checkout.redirectUrl),
          redirectUrlLen: checkout.redirectUrl?.length ?? 0,
          hasOrderId: Boolean(checkout.orderId),
          hasMerchantOrderId: Boolean(checkout.merchantOrderId),
          idempotencyReplay: checkout.idempotencyReplay,
        });
        // #endregion

        const successResponse: TransactionSessionSuccess = {
          pspReference: checkout.orderId,
          result: "CHARGE_ACTION_REQUIRED" as TransactionSessionSuccess["result"],
          message: "Redirect to FilixPay checkout",
          amount,
          externalUrl: checkout.redirectUrl,
          actions: [],
          data: {
            redirectUrl: checkout.redirectUrl,
            filixTradeNo: checkout.orderId,
            merchantOrderId: checkout.merchantOrderId,
            commerceCheckout: true,
            idempotencyReplay: checkout.idempotencyReplay,
          },
        };

        logger.info("Returning FilixPay redirect response to Saleor", {
          response: successResponse,
          commerceCheckout: true,
        });
        // #region agent log
        agentDebugLog("E", "transaction-initialize-session.ts:success", "returning redirect to Saleor", {
          result: successResponse.result,
          dataHasRedirectUrl: Boolean(
            successResponse.data &&
              typeof successResponse.data === "object" &&
              (successResponse.data as { redirectUrl?: unknown }).redirectUrl
          ),
          externalUrlPresent: Boolean(successResponse.externalUrl),
        });
        // #endregion

        return res.status(200).json(successResponse);
      } catch (err) {
        logger.error("Failed to initialize FilixPay transaction", {
          errorName: err instanceof Error ? err.name : undefined,
          errorMessage: err instanceof Error ? err.message : String(err),
          errorStack: err instanceof Error ? err.stack : undefined,
          responseData: (err as { response?: { data?: unknown; status?: number } })?.response?.data,
          responseStatus: (err as { response?: { status?: number } })?.response?.status,
        });
        // #region agent log
        agentDebugLog("B", "transaction-initialize-session.ts:catch", "initialize failed", {
          errorName: err instanceof Error ? err.name : typeof err,
          errorMessage: err instanceof Error ? err.message : String(err),
          responseStatus: (err as { response?: { status?: number } })?.response?.status ?? null,
        });
        // #endregion

        const errorResponse: TransactionSessionFailure = {
          pspReference: uuidv7(),
          result:
            actionType === TransactionFlowStrategyEnum.Charge
              ? "CHARGE_FAILURE"
              : "AUTHORIZATION_FAILURE",
          message:
            err instanceof Error
              ? `Failed to initialize FilixPay transaction: ${err.message}`
              : "Failed to initialize FilixPay transaction",
          amount,
          actions: [],
          data: {
            exception: true,
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        };

        return res.status(200).json(errorResponse);
      }
    }),
    "/api/webhooks/transaction-initialize-session"
  ),
  loggerContext
);

export const config = {
  api: {
    bodyParser: false,
  },
};

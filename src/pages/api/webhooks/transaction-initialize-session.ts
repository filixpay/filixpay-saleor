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

export default wrapWithLoggerContext(
  withOtel(
    transactionInitializeSessionWebhook.createHandler(async (req, res, ctx) => {
      const logger = createLogger("transaction-initialize-session");

      const { payload } = ctx;
      const { actionType, amount } = payload.action;

      logger.info("Received transaction initialize webhook", { payload });

      try {
        const commerceInput = extractCommercePaymentSessionInput(payload);
        if (!commerceInput) {
          throw new Error(
            "FilixPay Saleor checkout requires Checkout sourceObject with product lines; legacy POST /orders is disabled"
          );
        }

        const checkout = await createFilixPayCommercePaymentSession(commerceInput);

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

        return res.status(200).json(successResponse);
      } catch (err) {
        logger.error("Failed to initialize FilixPay transaction", {
          errorName: err instanceof Error ? err.name : undefined,
          errorMessage: err instanceof Error ? err.message : String(err),
          errorStack: err instanceof Error ? err.stack : undefined,
          responseData: (err as { response?: { data?: unknown; status?: number } })?.response?.data,
          responseStatus: (err as { response?: { status?: number } })?.response?.status,
        });

        const errorResponse: TransactionSessionFailure = {
          pspReference: uuidv7(),
          result:
            actionType === TransactionFlowStrategyEnum.Charge
              ? "CHARGE_FAILURE"
              : "AUTHORIZATION_FAILURE",
          message: "Failed to initialize FilixPay transaction",
          amount,
          actions: [],
          data: {
            exception: true,
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

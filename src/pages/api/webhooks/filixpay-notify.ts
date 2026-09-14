import { NextApiRequest, NextApiResponse } from "next";
import { createLogger } from "@/lib/logger/create-logger";
import { patchFilixPaySaleorOrderMetadata } from "@/modules/filixpay/client";
import { findSaleorTransaction } from "@/modules/filixpay/find-saleor-transaction";
import { resolveSaleorMetadataPatchTarget } from "@/modules/filixpay/saleor-metadata-patch";
import { reportSaleorTransactionEvent } from "@/modules/filixpay/saleor-transaction-report";
import {
  TransactionEventTypeEnum,
  TransactionFragment,
} from "@/generated/graphql";
import {
  mapFilixPayEventToSaleorEvent,
  parseFilixPayNotification,
  verifyFilixPaySignature,
} from "@/modules/filixpay/notify";
import { createFetchTransactionOrderSnapshot } from "@/modules/iching-deep-pack/fetch-transaction-order";
import { tryDeepPackGrantAfterChargeSuccess } from "@/modules/iching-deep-pack/orchestrate";

async function readRawBody(req: NextApiRequest) {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function getSignatureHeader(req: NextApiRequest) {
  const header = req.headers["x-filixpay-signature"];

  return Array.isArray(header) ? header[0] : header;
}

/**
 * Direct FilixPay API call (not another webhook) — enrich order with Saleor order id.
 * Best-effort: failures are logged and do not fail the notify response.
 */
async function patchFilixPayOrderSaleorMetadata(
  transaction: TransactionFragment,
  logger: ReturnType<typeof createLogger>
) {
  const target = resolveSaleorMetadataPatchTarget({
    pspReference: transaction.pspReference,
    saleorOrderId: transaction.order?.id,
    saleorOrderNumber: transaction.order?.number,
  });

  if (!target) {
    logger.warn("Skipping FilixPay saleor-metadata patch — missing FilixPay order UUID or Saleor order id", {
      pspReference: transaction.pspReference,
      saleorOrderId: transaction.order?.id,
    });
    return;
  }

  try {
    await patchFilixPaySaleorOrderMetadata(target);
    logger.info("Patched FilixPay order with Saleor order metadata", target);
  } catch (err) {
    logger.error("Failed to patch FilixPay saleor-metadata (non-fatal)", {
      ...target,
      errorName: err instanceof Error ? err.name : undefined,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

export default async function filixPayNotifyHandler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const logger = createLogger("filixpay-notify");

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    const rawBody = await readRawBody(req);
    const signature = getSignatureHeader(req);
    const webhookSecret = process.env.FILIXPAY_WEBHOOK_SECRET;

    // #region agent log
    fetch("http://127.0.0.1:7831/ingest/b078c2ef-9d88-4bed-aa48-04e9214be92e", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "a3afbf" },
      body: JSON.stringify({
        sessionId: "a3afbf",
        runId: "post-pay-stuck",
        hypothesisId: "H-notify",
        location: "filixpay-notify.ts:entry",
        message: "filixpay-notify received",
        data: {
          method: req.method,
          hasSignature: Boolean(signature),
          hasWebhookSecret: Boolean(webhookSecret),
          bodyLen: rawBody.length,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    if (!webhookSecret) {
      logger.error("FILIXPAY_WEBHOOK_SECRET is not configured");

      return res.status(500).json({ success: false, message: "Webhook secret not configured" });
    }

    if (!signature || !verifyFilixPaySignature(rawBody, signature, webhookSecret)) {
      logger.warn("Invalid FilixPay webhook signature");
      // #region agent log
      fetch("http://127.0.0.1:7831/ingest/b078c2ef-9d88-4bed-aa48-04e9214be92e", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "a3afbf" },
        body: JSON.stringify({
          sessionId: "a3afbf",
          runId: "post-pay-stuck",
          hypothesisId: "H-notify",
          location: "filixpay-notify.ts:signature",
          message: "signature rejected",
          data: { hasSignature: Boolean(signature) },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion

      return res.status(401).json({ success: false, message: "Invalid signature" });
    }

    const notification = parseFilixPayNotification(rawBody);
    const eventType = mapFilixPayEventToSaleorEvent(notification);
    const references = [notification.data.tradeNo, notification.data.merchantOrderId];
    // #region agent log
    fetch("http://127.0.0.1:7831/ingest/b078c2ef-9d88-4bed-aa48-04e9214be92e", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "a3afbf" },
      body: JSON.stringify({
        sessionId: "a3afbf",
        runId: "post-pay-stuck",
        hypothesisId: "H-notify",
        location: "filixpay-notify.ts:parsed",
        message: "notification parsed",
        data: {
          eventType: notification.eventType,
          mappedSaleorEvent: eventType,
          merchantOrderIdPrefix: notification.data.merchantOrderId?.slice(0, 14) ?? null,
          tradeNoLen: notification.data.tradeNo?.length ?? 0,
          amount: notification.data.amount,
          currency: notification.data.currency,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    const saleorTransaction = await findSaleorTransaction(references);

    if (!saleorTransaction) {
      logger.error("Unable to find Saleor transaction for FilixPay notification", {
        eventId: notification.eventId,
        references,
      });
      // #region agent log
      fetch("http://127.0.0.1:7831/ingest/b078c2ef-9d88-4bed-aa48-04e9214be92e", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "a3afbf" },
        body: JSON.stringify({
          sessionId: "a3afbf",
          runId: "post-pay-stuck",
          hypothesisId: "H-notify",
          location: "filixpay-notify.ts:not-found",
          message: "Saleor transaction not found",
          data: {
            merchantOrderIdPrefix: notification.data.merchantOrderId?.slice(0, 14) ?? null,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion

      return res.status(404).json({ success: false, message: "Saleor transaction not found" });
    }

    const reportResult = await reportSaleorTransactionEvent({
      authData: saleorTransaction.authData,
      transactionId: saleorTransaction.transaction.id,
      amount: notification.data.amount,
      eventType,
      pspReference: notification.data.tradeNo,
      message: `FilixPay ${notification.eventType} ${notification.eventId}`,
    });

    if (eventType === TransactionEventTypeEnum.ChargeSuccess) {
      // Best-effort side effects must not delay Notify 200 (FilixPay settlement ack).
      void patchFilixPayOrderSaleorMetadata(saleorTransaction.transaction, logger).catch((err) => {
        logger.error("Failed to patch FilixPay saleor-metadata (non-fatal)", {
          errorName: err instanceof Error ? err.name : undefined,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      });

      void tryDeepPackGrantAfterChargeSuccess({
        tradeNo: notification.data.tradeNo,
        merchantOrderId: notification.data.merchantOrderId,
        logger,
        fetchOrder: createFetchTransactionOrderSnapshot(
          saleorTransaction.authData,
          saleorTransaction.transaction.id
        ),
      }).catch((err) => {
        logger.error("Deep Pack orchestration unexpected error (non-fatal)", {
          paymentEventId: notification.data.tradeNo,
          merchantOrderId: notification.data.merchantOrderId,
          errorName: err instanceof Error ? err.name : undefined,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      });
    }

    logger.info("Processed FilixPay notification", {
      eventId: notification.eventId,
      eventType: notification.eventType,
      merchantOrderId: notification.data.merchantOrderId,
      tradeNo: notification.data.tradeNo,
      transactionId: saleorTransaction.transaction.id,
      alreadyProcessed: reportResult?.alreadyProcessed,
    });
    // #region agent log
    fetch("http://127.0.0.1:7831/ingest/b078c2ef-9d88-4bed-aa48-04e9214be92e", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "a3afbf" },
      body: JSON.stringify({
        sessionId: "a3afbf",
        runId: "post-pay-stuck",
        hypothesisId: "H-notify",
        location: "filixpay-notify.ts:success",
        message: "notification processed",
        data: {
          mappedSaleorEvent: eventType,
          alreadyProcessed: reportResult?.alreadyProcessed ?? null,
          hasOrder: Boolean(saleorTransaction.transaction.order?.id),
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    return res.status(200).json({ success: true });
  } catch (err) {
    logger.error("Failed to process FilixPay notification", {
      errorName: err instanceof Error ? err.name : undefined,
      errorMessage: err instanceof Error ? err.message : String(err),
      errorStack: err instanceof Error ? err.stack : undefined,
    });

    return res.status(500).json({ success: false, message: "Failed to process notification" });
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};

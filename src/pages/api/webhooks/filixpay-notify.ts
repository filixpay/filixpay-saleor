import { NextApiRequest, NextApiResponse } from "next";
import { saleorApp } from "@/saleor-app";
import { createClient } from "@/lib/create-graphql-client";
import { createLogger } from "@/lib/logger/create-logger";
import { patchFilixPaySaleorOrderMetadata } from "@/modules/filixpay/client";
import { resolveSaleorMetadataPatchTarget } from "@/modules/filixpay/saleor-metadata-patch";
import { reportSaleorTransactionEvent } from "@/modules/filixpay/saleor-transaction-report";
import {
  TransactionDetailsViaPspDocument,
  TransactionDetailsViaTokenDocument,
  TransactionEventTypeEnum,
  TransactionFragment,
} from "@/generated/graphql";
import {
  mapFilixPayEventToSaleorEvent,
  parseFilixPayNotification,
  verifyFilixPaySignature,
  getTransactionTokenFromMerchantOrderId,
} from "@/modules/filixpay/notify";

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

function transactionMatchesReference(transaction: TransactionFragment, references: string[]) {
  return (
    references.includes(transaction.pspReference) ||
    transaction.events.some((event) => references.includes(event.pspReference))
  );
}

async function findSaleorTransaction(references: string[]) {
  const authEntries = await saleorApp.apl.getAll();
  const merchantOrderId = references.find((reference) => reference.startsWith("SALEOR-"));
  const transactionToken = merchantOrderId
    ? getTransactionTokenFromMerchantOrderId(merchantOrderId)
    : null;

  for (const authData of authEntries) {
    const client = createClient(authData.saleorApiUrl, async () =>
      Promise.resolve({ token: authData.token })
    );

    if (transactionToken) {
      const result = await client.query(TransactionDetailsViaTokenDocument, {
        token: transactionToken,
      });

      if (result.error) {
        throw result.error;
      }

      if (result.data?.transaction) {
        return { authData, transaction: result.data.transaction };
      }
    }

    for (const reference of references) {
      const result = await client.query(TransactionDetailsViaPspDocument, {
        pspReference: reference,
      });

      if (result.error) {
        throw result.error;
      }

      const transaction = result.data?.orders?.edges
        .flatMap((edge) => edge.node.transactions)
        .find((candidate) => transactionMatchesReference(candidate, references));

      if (transaction) {
        return { authData, transaction };
      }
    }
  }

  return null;
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

    if (!webhookSecret) {
      logger.error("FILIXPAY_WEBHOOK_SECRET is not configured");

      return res.status(500).json({ success: false, message: "Webhook secret not configured" });
    }

    if (!signature || !verifyFilixPaySignature(rawBody, signature, webhookSecret)) {
      logger.warn("Invalid FilixPay webhook signature");

      return res.status(401).json({ success: false, message: "Invalid signature" });
    }

    const notification = parseFilixPayNotification(rawBody);
    const eventType = mapFilixPayEventToSaleorEvent(notification);
    const references = [notification.data.tradeNo, notification.data.merchantOrderId];
    const saleorTransaction = await findSaleorTransaction(references);

    if (!saleorTransaction) {
      logger.error("Unable to find Saleor transaction for FilixPay notification", {
        eventId: notification.eventId,
        references,
      });

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
      await patchFilixPayOrderSaleorMetadata(saleorTransaction.transaction, logger);
    }

    logger.info("Processed FilixPay notification", {
      eventId: notification.eventId,
      eventType: notification.eventType,
      merchantOrderId: notification.data.merchantOrderId,
      tradeNo: notification.data.tradeNo,
      transactionId: saleorTransaction.transaction.id,
      alreadyProcessed: reportResult?.alreadyProcessed,
    });

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

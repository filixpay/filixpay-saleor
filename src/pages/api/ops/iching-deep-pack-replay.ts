import { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";
import { createLogger } from "@/lib/logger/create-logger";
import { findSaleorTransaction } from "@/modules/filixpay/find-saleor-transaction";
import { createFetchTransactionOrderSnapshot } from "@/modules/iching-deep-pack/fetch-transaction-order";
import { runDeepPackReplay } from "@/modules/iching-deep-pack/replay";

const bodySchema = z.object({
  tradeNo: z.string().min(1),
  merchantOrderId: z.string().min(1),
});

function getReplaySecret(req: NextApiRequest): string | undefined {
  const header = req.headers["x-iching-deep-pack-replay-secret"];
  if (typeof header === "string" && header.trim()) {
    return header.trim();
  }
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  return undefined;
}

function expectedReplaySecret(): string | undefined {
  return (
    process.env.ICHING_DEEP_PACK_REPLAY_SECRET?.trim() ||
    process.env.ICHING_ENTITLEMENT_INGRESS_SECRET?.trim() ||
    undefined
  );
}

export default async function ichingDeepPackReplayHandler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const logger = createLogger("iching-deep-pack-replay");

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  const expected = expectedReplaySecret();
  if (!expected) {
    return res.status(503).json({ success: false, message: "Replay secret not configured" });
  }

  const provided = getReplaySecret(req);
  if (!provided || provided !== expected) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: "Invalid body", issues: parsed.error.issues });
  }

  const { tradeNo, merchantOrderId } = parsed.data;

  try {
    const saleorTransaction = await findSaleorTransaction([tradeNo, merchantOrderId]);
    if (!saleorTransaction) {
      return res.status(404).json({ success: false, message: "Saleor transaction not found" });
    }

    const result = await runDeepPackReplay({
      tradeNo,
      merchantOrderId,
      logger,
      fetchOrder: createFetchTransactionOrderSnapshot(
        saleorTransaction.authData,
        saleorTransaction.transaction.id
      ),
    });

    if (result.status === "cms_not_configured") {
      return res.status(503).json({ success: false, status: result.status });
    }

    if (result.status === "order_not_ready") {
      return res.status(409).json({
        success: false,
        status: result.status,
        checkoutId: result.checkoutId ?? undefined,
        paymentEventId: tradeNo,
        merchantOrderId,
      });
    }

    return res.status(200).json({
      success: true,
      status: result.status,
      outcomes: result.outcomes.map(({ target, result: ingress }) => ({
        eventId: target.eventId,
        orderLineId: target.sourceOrderLineId,
        readingId: target.readingId,
        ok: ingress.ok,
        kind: ingress.ok ? ingress.kind : undefined,
        code: ingress.ok ? undefined : ingress.code,
        status: ingress.ok ? undefined : ingress.status,
      })),
    });
  } catch (err) {
    logger.error("Deep Pack replay failed", {
      paymentEventId: tradeNo,
      merchantOrderId,
      errorName: err instanceof Error ? err.name : undefined,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({ success: false, message: "Replay failed" });
  }
}

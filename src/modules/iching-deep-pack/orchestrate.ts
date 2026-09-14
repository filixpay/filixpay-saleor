import { getCmsIngressConfig, postIchingEntitlementConfirmed } from "./cms-ingress-client";
import {
  findDeepPackLinesMissingReadingId,
  resolveEligibleDeepPackLines,
} from "./resolve-eligible-lines";
import type { CmsIngressResult, DeepPackGrantTarget, OrderLike } from "./types";
import {
  getDeepPackPollConfig,
  waitForSaleorOrder,
  type FetchOrderSnapshot,
} from "./wait-for-order";

type LoggerLike = {
  debug: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
};

function transactionTokenFromMerchantOrderId(merchantOrderId: string): string | null {
  return merchantOrderId.startsWith("SALEOR-") ? merchantOrderId.slice("SALEOR-".length) : null;
}

export async function grantDeepPackForOrder(params: {
  order: OrderLike;
  tradeNo: string;
  merchantOrderId: string;
  checkoutId?: string | null;
  cmsBaseUrl: string;
  secret: string;
  logger: LoggerLike;
  postConfirmed?: typeof postIchingEntitlementConfirmed;
}): Promise<Array<{ target: DeepPackGrantTarget; result: CmsIngressResult }>> {
  const postConfirmed = params.postConfirmed ?? postIchingEntitlementConfirmed;
  const token = transactionTokenFromMerchantOrderId(params.merchantOrderId);

  if (!params.order.user?.id) {
    params.logger.warn("Deep Pack skip: Order.user.id missing (purchaserUserId)", {
      paymentEventId: params.tradeNo,
      merchantOrderId: params.merchantOrderId,
      transactionToken: token,
      saleorOrderId: params.order.id,
      checkoutId: params.checkoutId ?? undefined,
      reason: "missing_purchaser_user_id",
    });
    return [];
  }

  for (const line of findDeepPackLinesMissingReadingId(params.order)) {
    params.logger.warn("Deep Pack skip line: OrderLine.metadata.readingId missing", {
      paymentEventId: params.tradeNo,
      merchantOrderId: params.merchantOrderId,
      transactionToken: token,
      saleorOrderId: params.order.id,
      orderLineId: line.id,
      sku: "ICHING-DEEP-199",
      checkoutId: params.checkoutId ?? undefined,
      reason: "missing_reading_id",
    });
  }

  const targets = resolveEligibleDeepPackLines(params.order, params.tradeNo);
  const outcomes: Array<{ target: DeepPackGrantTarget; result: CmsIngressResult }> = [];

  for (const target of targets) {
    const result = await postConfirmed({
      cmsBaseUrl: params.cmsBaseUrl,
      secret: params.secret,
      target,
    });
    outcomes.push({ target, result });

    if (result.ok) {
      params.logger.info("Deep Pack CMS ingress ack", {
        paymentEventId: params.tradeNo,
        merchantOrderId: params.merchantOrderId,
        transactionToken: token,
        saleorOrderId: target.sourceOrderId,
        orderLineId: target.sourceOrderLineId,
        readingId: target.readingId,
        sku: target.sku,
        kind: result.kind,
      });
    } else {
      const isOwned = result.code === "DEEP_PACK_ALREADY_OWNED";
      params.logger.error(
        isOwned
          ? "Deep Pack CMS DEEP_PACK_ALREADY_OWNED (commercial exception)"
          : "Deep Pack CMS ingress failed",
        {
          paymentEventId: params.tradeNo,
          merchantOrderId: params.merchantOrderId,
          transactionToken: token,
          saleorOrderId: target.sourceOrderId,
          orderLineId: target.sourceOrderLineId,
          readingId: target.readingId,
          sku: target.sku,
          status: result.status,
          code: result.code,
          message: result.message,
          reason: result.code ?? "cms_ingress_failed",
        }
      );
    }
  }

  return outcomes;
}

export async function tryDeepPackGrantAfterChargeSuccess(params: {
  tradeNo: string;
  merchantOrderId: string;
  logger: LoggerLike;
  fetchOrder: () => Promise<FetchOrderSnapshot>;
  getConfig?: typeof getCmsIngressConfig;
  postConfirmed?: typeof postIchingEntitlementConfirmed;
  sleep?: (ms: number) => Promise<void>;
  poll?: { attempts: number; baseDelayMs: number };
}): Promise<void> {
  const getConfig = params.getConfig ?? getCmsIngressConfig;
  const config = getConfig();
  if (!config) {
    params.logger.debug("Deep Pack skipped: CMS env not configured");
    return;
  }

  const poll = params.poll ?? getDeepPackPollConfig();
  const snapshot = await waitForSaleorOrder({
    fetchOrder: params.fetchOrder,
    sleep: params.sleep,
    attempts: poll.attempts,
    baseDelayMs: poll.baseDelayMs,
  });

  const token = transactionTokenFromMerchantOrderId(params.merchantOrderId);

  if (!snapshot?.order) {
    params.logger.warn("Deep Pack skip: Saleor Order not available after short window", {
      paymentEventId: params.tradeNo,
      merchantOrderId: params.merchantOrderId,
      transactionToken: token,
      checkoutId: snapshot?.checkoutId ?? undefined,
      reason: "order_not_ready",
    });
    return;
  }

  await grantDeepPackForOrder({
    order: snapshot.order,
    tradeNo: params.tradeNo,
    merchantOrderId: params.merchantOrderId,
    checkoutId: snapshot.checkoutId,
    cmsBaseUrl: config.cmsBaseUrl,
    secret: config.secret,
    logger: params.logger,
    postConfirmed: params.postConfirmed,
  });
}

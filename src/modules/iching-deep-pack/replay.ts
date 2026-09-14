import { getCmsIngressConfig, postIchingEntitlementConfirmed } from "./cms-ingress-client";
import { grantDeepPackForOrder } from "./orchestrate";
import type { FetchOrderSnapshot } from "./wait-for-order";

type LoggerLike = {
  debug: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
};

export async function runDeepPackReplay(params: {
  tradeNo: string;
  merchantOrderId: string;
  logger: LoggerLike;
  fetchOrder: () => Promise<FetchOrderSnapshot>;
  getConfig?: typeof getCmsIngressConfig;
  postConfirmed?: typeof postIchingEntitlementConfirmed;
}): Promise<
  | { status: "ok"; outcomes: Awaited<ReturnType<typeof grantDeepPackForOrder>> }
  | { status: "order_not_ready"; checkoutId?: string | null }
  | { status: "cms_not_configured" }
> {
  const config = (params.getConfig ?? getCmsIngressConfig)();
  if (!config) {
    return { status: "cms_not_configured" };
  }

  const snapshot = await params.fetchOrder();
  if (!snapshot.order) {
    return { status: "order_not_ready", checkoutId: snapshot.checkoutId };
  }

  const outcomes = await grantDeepPackForOrder({
    order: snapshot.order,
    tradeNo: params.tradeNo,
    merchantOrderId: params.merchantOrderId,
    checkoutId: snapshot.checkoutId,
    cmsBaseUrl: config.cmsBaseUrl,
    secret: config.secret,
    logger: params.logger,
    postConfirmed: params.postConfirmed,
  });

  return { status: "ok", outcomes };
}

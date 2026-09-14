import type { CmsIngressResult, CmsIngressSuccessKind, DeepPackGrantTarget } from "./types";

export type CmsIngressConfig = {
  cmsBaseUrl: string;
  secret: string;
};

export function getCmsIngressConfig(
  env: NodeJS.ProcessEnv = process.env
): CmsIngressConfig | null {
  const cmsBaseUrl = env.MICSELECT_CMS_BASE_URL?.trim().replace(/\/$/, "");
  const secret = env.ICHING_ENTITLEMENT_INGRESS_SECRET?.trim();
  if (!cmsBaseUrl || !secret) {
    return null;
  }
  return { cmsBaseUrl, secret };
}

const SUCCESS_KINDS = new Set<CmsIngressSuccessKind>([
  "fulfilled",
  "already_fulfilled",
  "replayed",
]);

export async function postIchingEntitlementConfirmed(input: {
  cmsBaseUrl: string;
  secret: string;
  target: DeepPackGrantTarget;
  fetchImpl?: typeof fetch;
}): Promise<CmsIngressResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = `${input.cmsBaseUrl.replace(/\/$/, "")}/api/iching/entitlement/ingress/confirmed`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iching-entitlement-secret": input.secret,
    },
    body: JSON.stringify({
      eventId: input.target.eventId,
      filixPaymentState: "CONFIRMED",
      sourceOrderId: input.target.sourceOrderId,
      sourceOrderLineId: input.target.sourceOrderLineId,
      sku: input.target.sku,
      readingId: input.target.readingId,
      purchaserUserId: input.target.purchaserUserId,
    }),
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, status: response.status, message: "invalid JSON response" };
  }

  if (response.status === 200 && body && typeof body === "object" && "kind" in body) {
    const kind = (body as { kind: string }).kind;
    if (SUCCESS_KINDS.has(kind as CmsIngressSuccessKind)) {
      return { ok: true, kind: kind as CmsIngressSuccessKind };
    }
  }

  const error =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: { code?: string; message?: string } }).error
      : undefined;

  return {
    ok: false,
    status: response.status,
    code: error?.code,
    message: error?.message,
  };
}

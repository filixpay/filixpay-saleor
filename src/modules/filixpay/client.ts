import {
  FetchLike,
  FilixPayAccessToken,
  FilixPayCheckoutResult,
  FilixPayCommercePaymentSessionPayload,
  FilixPayCommercePaymentSessionResult,
  FilixPayConfig,
  FilixPayCreateOrderInput,
  FilixPayCreateOrderPayload,
  FilixPayOrderResult,
  FilixPayPaymentTokenResult,
  FilixPayPatchSaleorOrderMetadataInput,
} from "./types";
import type { FilixPayCommercePaymentSessionInput } from "./commerce-session";

type Env = Record<string, string | undefined>;

const accessTokenCache = new Map<string, FilixPayAccessToken & { expiresAt: number }>();

function readRequiredEnv(env: Env, key: string) {
  const value = env[key]?.trim();

  if (!value) {
    throw new Error(`Missing required FilixPay environment variable: ${key}`);
  }

  return value;
}

export function getFilixPayConfig(env: Env = process.env): FilixPayConfig {
  return {
    apiBaseUrl: readRequiredEnv(env, "FILIXPAY_API_BASE_URL"),
    tokenUrl: readRequiredEnv(env, "FILIXPAY_TOKEN_URL"),
    clientId: readRequiredEnv(env, "FILIXPAY_CLIENT_ID"),
    clientSecret: readRequiredEnv(env, "FILIXPAY_CLIENT_SECRET"),
    webhookSecret: env.FILIXPAY_WEBHOOK_SECRET?.trim(),
  };
}

/** Test-only: clear OAuth token cache between Vitest cases. */
export function clearFilixPayAccessTokenCache() {
  accessTokenCache.clear();
}

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function readJsonResponse(response: Response) {
  const responseText = await response.text();

  try {
    return responseText ? JSON.parse(responseText) : null;
  } catch {
    throw new Error(`FilixPay returned invalid JSON: ${responseText.slice(0, 500)}`);
  }
}

function ensureApiSuccess(body: unknown, context: string) {
  if (!body || typeof body !== "object") {
    throw new Error(`${context} returned an empty response`);
  }

  const response = body as Record<string, unknown>;

  if (response.success === false) {
    throw new Error(`${context} failed: ${String(response.code ?? "UNKNOWN")} ${String(response.message ?? "")}`);
  }

  return response;
}

function stringField(input: unknown, field: string) {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const value = (input as Record<string, unknown>)[field];

  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(input: unknown, field: string) {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const value = (input as Record<string, unknown>)[field];

  return typeof value === "number" ? value : undefined;
}

export function buildMerchantOrderId(saleorTransactionToken: string) {
  return `SALEOR-${saleorTransactionToken}`;
}

export function buildCommercePaymentSessionPayload(
  input: FilixPayCommercePaymentSessionInput
): FilixPayCommercePaymentSessionPayload {
  return {
    saleorCheckoutId: input.saleorCheckoutId,
    saleorTransactionToken: input.saleorTransactionToken,
    amount: input.amount,
    currency: input.currency,
    returnUrl: input.returnUrl,
    buyer: {
      email: input.buyerEmail,
    },
    country: input.country,
    // Filix commerce V1 OpenAPI accepts only ids + quantity on lines.
    // Extra denormalized fields can break strict deserializers and kill redirectUrl.
    lines: input.lines.map((line) => ({
      saleorProductId: line.saleorProductId,
      saleorVariantId: line.saleorVariantId,
      quantity: line.quantity,
    })),
  };
}

export function buildCreateOrderPayload(
  input: FilixPayCreateOrderInput
): FilixPayCreateOrderPayload {
  return {
    merchantOrderId: input.merchantOrderId,
    subject: input.subject,
    returnUrl: input.returnUrl,
    totalAmount: {
      currency: input.currency,
      amount: input.amount,
    },
    orderItems: [
      {
        productId: "saleor-transaction",
        productName: "Saleor checkout payment",
        quantity: 1,
        unitPrice: input.amount,
      },
    ],
  };
}

export async function getFilixPayAccessToken(
  env: Env = process.env,
  fetchFn: FetchLike = fetch
): Promise<FilixPayAccessToken> {
  const config = getFilixPayConfig(env);
  const cacheKey = `${config.tokenUrl}|${config.clientId}`;
  const cachedToken = accessTokenCache.get(cacheKey);

  if (cachedToken && cachedToken.expiresAt - 30_000 > Date.now()) {
    return {
      accessToken: cachedToken.accessToken,
      expiresIn: Math.max(0, Math.floor((cachedToken.expiresAt - Date.now()) / 1000)),
    };
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const response = await fetchFn(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const responseBody = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(`FilixPay token request failed with HTTP ${response.status}`);
  }

  const accessToken = stringField(responseBody, "access_token");
  const expiresIn = numberField(responseBody, "expires_in") ?? 0;

  if (!accessToken) {
    throw new Error("FilixPay token response is missing access_token");
  }

  accessTokenCache.set(cacheKey, {
    accessToken,
    expiresIn,
    expiresAt: Date.now() + expiresIn * 1000,
  });

  return {
    accessToken,
    expiresIn,
  };
}

export async function createFilixPayOrder(
  input: FilixPayCreateOrderInput,
  accessToken: string,
  env: Env = process.env,
  fetchFn: FetchLike = fetch
): Promise<FilixPayOrderResult> {
  const config = getFilixPayConfig(env);
  const payload = buildCreateOrderPayload(input);
  const response = await fetchFn(joinUrl(config.apiBaseUrl, "/orders"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const responseBody = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(`FilixPay create-order failed with HTTP ${response.status}`);
  }

  const apiResponse = ensureApiSuccess(responseBody, "FilixPay create-order");
  const data = apiResponse.data;

  return {
    merchantOrderId: stringField(data, "merchantOrderId") || input.merchantOrderId,
    tradeNo: stringField(data, "tradeNo"),
    raw: responseBody,
  };
}

export async function getFilixPayPaymentToken(
  merchantOrderId: string,
  accessToken: string,
  env: Env = process.env,
  fetchFn: FetchLike = fetch
): Promise<FilixPayPaymentTokenResult> {
  const config = getFilixPayConfig(env);
  const response = await fetchFn(
    joinUrl(config.apiBaseUrl, `/orders/${encodeURIComponent(merchantOrderId)}/payment-token`),
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );
  const responseBody = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(`FilixPay payment-token request failed with HTTP ${response.status}`);
  }

  const apiResponse = ensureApiSuccess(responseBody, "FilixPay payment-token");
  const data = apiResponse.data;
  const paymentToken = stringField(data, "paymentToken");
  const expiresIn = numberField(data, "expiresIn");
  const payUrl = stringField(data, "payUrl");

  if (!paymentToken || typeof expiresIn !== "number" || !payUrl) {
    throw new Error("FilixPay payment-token response is missing paymentToken, expiresIn, or payUrl");
  }

  return {
    merchantOrderId,
    paymentToken,
    expiresIn,
    payUrl,
  };
}

export async function createFilixPayCommercePaymentSession(
  input: FilixPayCommercePaymentSessionInput,
  env: Env = process.env,
  fetchFn: FetchLike = fetch
): Promise<FilixPayCommercePaymentSessionResult> {
  const config = getFilixPayConfig(env);
  const token = await getFilixPayAccessToken(env, fetchFn);
  const payload = buildCommercePaymentSessionPayload(input);
  const response = await fetchFn(joinUrl(config.apiBaseUrl, "/commerce/saleor/payment-sessions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const responseBody = await readJsonResponse(response);

  // #region agent log
  fetch("http://127.0.0.1:7831/ingest/b078c2ef-9d88-4bed-aa48-04e9214be92e", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "a3afbf" },
    body: JSON.stringify({
      sessionId: "a3afbf",
      runId: "pre-fix",
      hypothesisId: "C",
      location: "client.ts:createFilixPayCommercePaymentSession",
      message: "filix payment-sessions HTTP response",
      data: {
        httpOk: response.ok,
        httpStatus: response.status,
        success:
          responseBody && typeof responseBody === "object"
            ? (responseBody as { success?: unknown }).success
            : null,
        code:
          responseBody && typeof responseBody === "object"
            ? (responseBody as { code?: unknown }).code
            : null,
        message:
          responseBody && typeof responseBody === "object"
            ? String((responseBody as { message?: unknown }).message ?? "").slice(0, 200)
            : null,
        hasRedirectUrl: Boolean(
          responseBody &&
            typeof responseBody === "object" &&
            (responseBody as { data?: { redirectUrl?: unknown } }).data?.redirectUrl
        ),
        lineCount: payload.lines.length,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  if (!response.ok) {
    throw new Error(
      `FilixPay commerce payment-session failed with HTTP ${response.status}: ${JSON.stringify(responseBody).slice(0, 500)}`
    );
  }

  const apiResponse = ensureApiSuccess(responseBody, "FilixPay commerce payment-session");
  const data = apiResponse.data;

  const orderId = stringField(data, "orderId");
  const merchantOrderId = stringField(data, "merchantOrderId");
  const redirectUrl = stringField(data, "redirectUrl");

  if (!orderId || !merchantOrderId || !redirectUrl) {
    throw new Error(
      `FilixPay commerce payment-session response is missing orderId, merchantOrderId, or redirectUrl: ${JSON.stringify(responseBody).slice(0, 500)}`
    );
  }

  return {
    orderId,
    merchantOrderId,
    redirectUrl,
    expiresAt: stringField(data, "expiresAt"),
    idempotencyReplay:
      typeof data === "object" &&
      data !== null &&
      (data as Record<string, unknown>).idempotencyReplay === true,
  };
}

/**
 * Best-effort enrichment after Saleor order exists — writes saleor_order_id onto FilixPay order metadata.
 */
export async function patchFilixPaySaleorOrderMetadata(
  input: FilixPayPatchSaleorOrderMetadataInput,
  env: Env = process.env,
  fetchFn: FetchLike = fetch
): Promise<void> {
  const config = getFilixPayConfig(env);
  const token = await getFilixPayAccessToken(env, fetchFn);
  const body: Record<string, string> = {
    saleorOrderId: input.saleorOrderId,
  };
  if (input.saleorOrderNumber) {
    body.saleorOrderNumber = input.saleorOrderNumber;
  }

  const response = await fetchFn(
    joinUrl(
      config.apiBaseUrl,
      `/commerce/saleor/orders/${encodeURIComponent(input.filixPayOrderId)}/saleor-metadata`
    ),
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  const responseBody = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      `FilixPay saleor-metadata patch failed with HTTP ${response.status}: ${JSON.stringify(responseBody).slice(0, 500)}`
    );
  }

  ensureApiSuccess(responseBody, "FilixPay saleor-metadata patch");
}

export async function createFilixPayCheckout(
  input: FilixPayCreateOrderInput,
  env: Env = process.env,
  fetchFn: FetchLike = fetch
): Promise<FilixPayCheckoutResult> {
  const token = await getFilixPayAccessToken(env, fetchFn);
  const order = await createFilixPayOrder(input, token.accessToken, env, fetchFn);
  const payment = await getFilixPayPaymentToken(order.merchantOrderId, token.accessToken, env, fetchFn);

  return {
    ...payment,
    tradeNo: order.tradeNo,
  };
}

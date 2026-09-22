import type { AuthData } from "@saleor/app-sdk/APL";
import { createClient } from "@/lib/create-graphql-client";
import { saleorApp } from "@/saleor-app";
import {
  PaidNoOrderLookupDocument,
  TransactionEventTypeEnum,
} from "@/generated/graphql";
import { getFilixPayAccessToken, getFilixPayConfig } from "./client";
import { normalizeFilixOrderId } from "./order-id";
import type { PushCompleteTransactionSnapshot } from "./push-complete.types";
import { reportSaleorTransactionEvent } from "./saleor-transaction-report";
import type { SyncPaymentDeps } from "./sync-payment.types";

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;

type LookupHit = {
  authData: AuthData;
  transaction: PushCompleteTransactionSnapshot;
};

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

/**
 * Load paid Filix order snapshot for sync — amount/tradeNo come from Filix, never invented.
 * Throws when the HTTP/API call fails. Returns not_paid when the order exists but is unpaid.
 */
export async function fetchFilixPaidOrderForSync(
  filixOrderId: string,
  env: Env = process.env,
  fetchFn: FetchLike = fetch
): Promise<{ amount: number; currency: string; tradeNo: string }> {
  const config = getFilixPayConfig(env);
  const token = await getFilixPayAccessToken(env, fetchFn);
  const merchantOrderId = normalizeFilixOrderId(filixOrderId);
  const response = await fetchFn(
    joinUrl(config.apiBaseUrl, `/orders/${encodeURIComponent(merchantOrderId)}`),
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
      },
    }
  );
  const body = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`FilixPay get-order failed with HTTP ${response.status}`);
  }
  if (!body || typeof body !== "object" || (body as { success?: boolean }).success === false) {
    throw new Error("FilixPay get-order returned unsuccessful response");
  }

  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    throw new Error("FilixPay get-order missing data");
  }

  const record = data as Record<string, unknown>;
  const tradeNo =
    (typeof record.tradeNo === "string" && record.tradeNo.trim()) ||
    (typeof record.id === "string" && record.id.trim()) ||
    "";
  const totalAmount = record.totalAmount;
  let amount: number | undefined;
  let currency: string | undefined;

  if (totalAmount && typeof totalAmount === "object") {
    const total = totalAmount as Record<string, unknown>;
    if (typeof total.amount === "number" && Number.isFinite(total.amount)) {
      amount = total.amount;
    }
    if (typeof total.currency === "string" && total.currency.trim()) {
      currency = total.currency.trim();
    }
  }

  if (typeof record.amount === "number" && Number.isFinite(record.amount)) {
    amount = record.amount;
  }
  if (typeof record.currency === "string" && record.currency.trim()) {
    currency = record.currency.trim();
  }

  const status = typeof record.status === "string" ? record.status.toUpperCase() : "";
  const tradeStatus =
    typeof record.tradeStatus === "string" ? record.tradeStatus.toUpperCase() : "";
  const paidHint =
    status.includes("PAID") ||
    status.includes("SUCCESS") ||
    status.includes("COMPLETED") ||
    tradeStatus.includes("SUCCESS") ||
    tradeStatus.includes("PAID") ||
    tradeStatus.includes("COMPLETED") ||
    record.paid === true;

  if (!paidHint) {
    const notPaid = new Error("FilixPay order is not paid");
    notPaid.name = "FilixOrderNotPaidError";
    throw notPaid;
  }

  if (amount == null || amount < 0 || !currency || !tradeNo) {
    throw new Error("FilixPay paid order is missing amount, currency, or tradeNo");
  }

  return { amount, currency, tradeNo };
}

export async function lookupTransactionAcrossApl(
  transactionToken: string
): Promise<LookupHit | null> {
  const authEntries = await saleorApp.apl.getAll();

  for (const authData of authEntries) {
    const client = createClient(authData.saleorApiUrl, async () =>
      Promise.resolve({ token: authData.token })
    );
    const result = await client.query(PaidNoOrderLookupDocument, {
      token: transactionToken,
    });

    if (result.error) {
      throw result.error;
    }

    const transaction = result.data?.transaction;
    if (transaction) {
      return {
        authData,
        transaction: {
          id: transaction.id,
          token: transaction.token,
          pspReference: transaction.pspReference,
          chargedAmount: transaction.chargedAmount,
          authorizedAmount: transaction.authorizedAmount,
          checkout: transaction.checkout
            ? {
                id: transaction.checkout.id,
                chargeStatus: transaction.checkout.chargeStatus,
                authorizeStatus: transaction.checkout.authorizeStatus,
                totalPrice: transaction.checkout.totalPrice,
              }
            : null,
          order: transaction.order
            ? {
                id: transaction.order.id,
                number: transaction.order.number,
              }
            : null,
        },
      };
    }
  }

  return null;
}

export async function reportFilixPaidOrderToSaleor(params: {
  authData: AuthData;
  transaction: PushCompleteTransactionSnapshot;
  amount: number;
  tradeNo: string;
  filixOrderId: string;
  messagePrefix?: string;
}) {
  await reportSaleorTransactionEvent({
    authData: params.authData,
    transactionId: params.transaction.id,
    amount: params.amount,
    eventType: TransactionEventTypeEnum.ChargeSuccess,
    pspReference: params.tradeNo,
    message:
      params.messagePrefix ??
      `FilixPay sync-payment for ${params.filixOrderId}`,
  });
}

/**
 * Production deps for storefront refresh reconcile (sync only — no checkoutComplete).
 */
export function createSyncPaymentDeps(options?: {
  env?: Env;
  fetchFn?: FetchLike;
}): SyncPaymentDeps {
  const env = options?.env ?? process.env;
  const fetchFn = options?.fetchFn ?? fetch;
  let lastAuth: AuthData | null = null;

  return {
    async lookupTransaction(transactionToken) {
      const hit = await lookupTransactionAcrossApl(transactionToken);
      lastAuth = hit?.authData ?? null;
      return hit?.transaction ?? null;
    },

    async fetchPaidOrder(filixOrderId) {
      try {
        const order = await fetchFilixPaidOrderForSync(filixOrderId, env, fetchFn);
        return { status: "paid" as const, order };
      } catch (err) {
        if (err instanceof Error && err.name === "FilixOrderNotPaidError") {
          return { status: "not_paid" as const };
        }
        throw err;
      }
    },

    async reportChargeSuccess({ transaction, amount, tradeNo, filixOrderId }) {
      const token =
        (typeof transaction.token === "string" && transaction.token.trim()) || null;
      if (!token) {
        throw new Error("Cannot sync payment without Saleor transaction token");
      }

      const hit = lastAuth
        ? { authData: lastAuth, transaction }
        : await lookupTransactionAcrossApl(token);
      if (!hit) {
        throw new Error("Cannot sync payment — Saleor transaction not found");
      }

      await reportFilixPaidOrderToSaleor({
        authData: hit.authData,
        transaction,
        amount,
        tradeNo,
        filixOrderId,
        messagePrefix: `FilixPay sync-payment for ${filixOrderId}`,
      });
    },
  };
}

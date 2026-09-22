import type { AuthData } from "@saleor/app-sdk/APL";
import { createClient } from "@/lib/create-graphql-client";
import { CompleteCheckoutDocument } from "@/generated/graphql";
import { buildMerchantOrderId } from "./client";
import type { PushCompleteDeps } from "./push-complete.types";
import {
  fetchFilixPaidOrderForSync,
  lookupTransactionAcrossApl,
  reportFilixPaidOrderToSaleor,
} from "./sync-payment-deps";

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;

export { fetchFilixPaidOrderForSync } from "./sync-payment-deps";

/**
 * Production deps for push-complete: Saleor lookup/complete + Filix amount sync via transactionEventReport.
 */
export function createPushCompleteDeps(options?: {
  env?: Env;
  fetchFn?: FetchLike;
}): PushCompleteDeps {
  const env = options?.env ?? process.env;
  const fetchFn = options?.fetchFn ?? fetch;
  let lastAuth: AuthData | null = null;

  return {
    async lookupTransaction(transactionToken) {
      const hit = await lookupTransactionAcrossApl(transactionToken);
      lastAuth = hit?.authData ?? null;
      return hit?.transaction ?? null;
    },

    async syncPayment(transaction) {
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

      const filixOrderId = buildMerchantOrderId(token);
      const paid = await fetchFilixPaidOrderForSync(filixOrderId, env, fetchFn);

      const checkoutAmount = transaction.checkout?.totalPrice?.gross?.amount;
      if (
        typeof checkoutAmount === "number" &&
        Number.isFinite(checkoutAmount) &&
        Math.abs(checkoutAmount - paid.amount) > 0.009
      ) {
        throw new Error(
          `Filix paid amount ${paid.amount} does not match Saleor checkout total ${checkoutAmount}`
        );
      }

      await reportFilixPaidOrderToSaleor({
        authData: hit.authData,
        transaction,
        amount: paid.amount,
        tradeNo: paid.tradeNo,
        filixOrderId,
        messagePrefix: `FilixPay push-complete sync for ${filixOrderId}`,
      });
    },

    async checkoutComplete(checkoutId) {
      if (!lastAuth) {
        throw new Error("Cannot checkoutComplete without Saleor auth context");
      }
      const client = createClient(lastAuth.saleorApiUrl, async () =>
        Promise.resolve({ token: lastAuth!.token })
      );
      const result = await client.mutation(CompleteCheckoutDocument, { id: checkoutId });
      if (result.error) {
        throw result.error;
      }
      const payload = result.data?.checkoutComplete;
      return {
        order: payload?.order
          ? { id: payload.order.id, number: payload.order.number }
          : null,
        errors: payload?.errors ?? [],
      };
    },
  };
}

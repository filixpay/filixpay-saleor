import { AuthData } from "@saleor/app-sdk/APL";
import { createClient } from "@/lib/create-graphql-client";
import { TransactionDetailsViaIdDocument } from "@/generated/graphql";
import type { OrderLike } from "./types";
import type { FetchOrderSnapshot } from "./wait-for-order";

export function createFetchTransactionOrderSnapshot(
  authData: AuthData,
  transactionId: string
): () => Promise<FetchOrderSnapshot> {
  return async () => {
    const client = createClient(authData.saleorApiUrl, async () =>
      Promise.resolve({ token: authData.token })
    );
    const result = await client.query(TransactionDetailsViaIdDocument, {
      id: transactionId,
    });
    if (result.error) {
      throw result.error;
    }
    const transaction = result.data?.transaction;
    const order = transaction?.order;
    return {
      order: order
        ? ({
            id: order.id,
            user: order.user ? { id: order.user.id } : null,
            lines: (order.lines ?? []).map((line) => ({
              id: line.id,
              metadata: (line.metadata ?? []).map((m) => ({ key: m.key, value: m.value })),
              variant: line.variant ? { sku: line.variant.sku } : null,
            })),
          } satisfies OrderLike)
        : null,
      checkoutId: transaction?.checkout?.id ?? null,
    };
  };
}

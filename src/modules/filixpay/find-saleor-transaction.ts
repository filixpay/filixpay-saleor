import { AuthData } from "@saleor/app-sdk/APL";
import { saleorApp } from "@/saleor-app";
import { createClient } from "@/lib/create-graphql-client";
import {
  TransactionDetailsViaPspDocument,
  TransactionDetailsViaTokenDocument,
  TransactionFragment,
} from "@/generated/graphql";
import { getTransactionTokenFromMerchantOrderId } from "@/modules/filixpay/notify";

function transactionMatchesReference(transaction: TransactionFragment, references: string[]) {
  return (
    references.includes(transaction.pspReference) ||
    transaction.events.some((event) => references.includes(event.pspReference))
  );
}

export async function findSaleorTransaction(
  references: string[]
): Promise<{ authData: AuthData; transaction: TransactionFragment } | null> {
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

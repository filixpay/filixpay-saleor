import { AuthData } from "@saleor/app-sdk/APL";
import { createClient } from "@/lib/create-graphql-client";
import { getTransactionActions } from "@/lib/transaction-actions";
import { AppUrlGenerator } from "@/modules/url/app-url-generator";
import {
  TransactionActionEnum,
  TransactionEventReportDocument,
  TransactionEventTypeEnum,
} from "@/generated/graphql";

export async function reportSaleorTransactionEvent(params: {
  authData: AuthData;
  transactionId: string;
  amount: number;
  eventType: TransactionEventTypeEnum;
  pspReference: string;
  message: string;
}) {
  const client = createClient(params.authData.saleorApiUrl, async () =>
    Promise.resolve({ token: params.authData.token })
  );
  const urlGenerator = new AppUrlGenerator(params.authData);
  const result = await client.mutation(TransactionEventReportDocument, {
    id: params.transactionId,
    amount: params.amount,
    type: params.eventType,
    pspReference: params.pspReference,
    message: params.message,
    availableActions: getTransactionActions(params.eventType) as TransactionActionEnum[],
    externalUrl: urlGenerator.getTransactionDetailsUrl(params.transactionId),
  });

  if (result.error) {
    throw result.error;
  }

  const errors = result.data?.transactionEventReport?.errors;

  if (errors && errors.length > 0) {
    throw new Error(errors.map((error) => error.message).join(", "));
  }

  return result.data?.transactionEventReport;
}

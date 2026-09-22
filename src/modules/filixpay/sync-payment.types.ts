import type { PushCompleteTransactionSnapshot } from "./push-complete.types";

export type SyncPaymentStatus =
  | "synced"
  | "already_paid"
  | "not_paid"
  | "not_found"
  | "amount_mismatch"
  | "failed";

export type SyncPaymentResult = {
  status: SyncPaymentStatus;
  filixOrderId: string;
  saleorTransactionId?: string;
  pspReference?: string;
  error?: { message: string };
};

export type FilixPaidOrderSnapshot = {
  amount: number;
  currency: string;
  tradeNo: string;
};

export type SyncPaymentDeps = {
  lookupTransaction: (
    transactionToken: string
  ) => Promise<PushCompleteTransactionSnapshot | null>;
  fetchPaidOrder: (
    filixOrderId: string
  ) => Promise<{ status: "paid"; order: FilixPaidOrderSnapshot } | { status: "not_paid" }>;
  reportChargeSuccess: (input: {
    transaction: PushCompleteTransactionSnapshot;
    amount: number;
    tradeNo: string;
    filixOrderId: string;
  }) => Promise<void>;
  isAlreadyPaid?: (transaction: PushCompleteTransactionSnapshot) => boolean;
};

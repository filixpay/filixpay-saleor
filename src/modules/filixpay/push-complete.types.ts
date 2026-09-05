export type PushCompleteStatus = "completed" | "already_completed" | "failed";

export type PushCompleteErrorCode =
  | "PAYMENT_NOT_SETTLED"
  | "CHECKOUT_GONE"
  | "CHECKOUT_NOT_FULLY_PAID"
  | "INSUFFICIENT_STOCK"
  | "NOT_ELIGIBLE"
  | "FORBIDDEN"
  | "INTERNAL";

export type PushCompleteResult = {
  status: PushCompleteStatus;
  filixOrderId: string;
  saleorOrderNumber?: string;
  saleorOrderId?: string;
  steps: { paymentSynced: boolean; checkoutCompleted: boolean };
  error?: { code: PushCompleteErrorCode; message: string };
};

export type PushCompleteCheckoutSnapshot = {
  id: string;
  chargeStatus?: string | null;
  authorizeStatus?: string | null;
  totalPrice?: { gross?: { amount?: number | null; currency?: string | null } | null } | null;
};

export type PushCompleteOrderSnapshot = {
  id: string;
  number: string;
};

export type PushCompleteTransactionSnapshot = {
  id: string;
  token?: string | null;
  pspReference?: string | null;
  chargedAmount?: { amount?: number | null; currency?: string | null } | null;
  authorizedAmount?: { amount?: number | null; currency?: string | null } | null;
  checkout?: PushCompleteCheckoutSnapshot | null;
  order?: PushCompleteOrderSnapshot | null;
};

export type PushCompleteCheckoutResult = {
  order?: PushCompleteOrderSnapshot | null;
  errors?: Array<{ code?: string | null; message?: string | null; field?: string | null }> | null;
};

export type PushCompleteDeps = {
  lookupTransaction: (
    transactionToken: string
  ) => Promise<PushCompleteTransactionSnapshot | null>;
  /**
   * Replay Filix→Saleor charge settlement (transactionEventReport).
   * Must reuse real Filix/Saleor amounts — never invent charges.
   */
  syncPayment: (transaction: PushCompleteTransactionSnapshot) => Promise<void>;
  checkoutComplete: (checkoutId: string) => Promise<PushCompleteCheckoutResult>;
  /** Optional transaction-level paid hint when checkout statuses are unavailable. */
  isTransactionPaid?: (transaction: PushCompleteTransactionSnapshot | null) => boolean;
};

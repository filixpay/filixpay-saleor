export type FetchLike = typeof fetch;

export type FilixPayConfig = {
  apiBaseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  webhookSecret?: string;
};

export type FilixPayAccessToken = {
  accessToken: string;
  expiresIn: number;
};

export type FilixPayCreateOrderInput = {
  merchantOrderId: string;
  amount: number;
  currency: string;
  subject: string;
  returnUrl: string;
};

export type FilixPayOrderItem = {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
};

export type FilixPayCreateOrderPayload = {
  merchantOrderId: string;
  subject: string;
  returnUrl: string;
  totalAmount: {
    currency: string;
    amount: number;
  };
  orderItems: FilixPayOrderItem[];
};

export type FilixPayOrderResult = {
  merchantOrderId: string;
  tradeNo?: string;
  raw: unknown;
};

export type FilixPayPaymentTokenResult = {
  merchantOrderId: string;
  paymentToken: string;
  expiresIn: number;
  payUrl: string;
};

export type FilixPayCheckoutResult = FilixPayPaymentTokenResult & {
  tradeNo?: string;
};

export type FilixPayCommercePaymentSessionPayload = {
  saleorCheckoutId: string;
  saleorTransactionToken: string;
  amount: number;
  currency: string;
  returnUrl: string;
  buyer: {
    email: string;
  };
  country?: string;
  lines: Array<{
    saleorProductId: string;
    saleorVariantId: string;
    quantity: number;
    productName: string;
    sku?: string;
    unitPrice: number;
  }>;
};

export type FilixPayCommercePaymentSessionResult = {
  orderId: string;
  merchantOrderId: string;
  redirectUrl: string;
  expiresAt?: string;
  idempotencyReplay: boolean;
};

export type FilixPayPatchSaleorOrderMetadataInput = {
  filixPayOrderId: string;
  saleorOrderId: string;
  saleorOrderNumber?: string;
};

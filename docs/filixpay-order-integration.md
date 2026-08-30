# FilixPay Order Integration

## Current State

The Saleor storefront now uses the payment gateway ID `com.filixpay.payment-app`.
When the customer clicks **Filix Pay**, the storefront calls Saleor
`transactionInitialize`, and Saleor calls this app's
`TRANSACTION_INITIALIZE_SESSION` webhook:

```text
src/pages/api/webhooks/transaction-initialize-session.ts
```

The webhook delivery and signature verification are now working. The production
Nginx config must continue proxying Saleor JWKS correctly:

```text
https://www.example.com/.well-known/jwks.json
```

That URL must return a JSON body like `{"keys":[...]}`. If it returns a
storefront 404 page, Saleor webhook signature verification fails with
`SIGNATURE_VERIFICATION_FAILED`.

The storefront expects the webhook response data to include either:

```json
{
  "externalUrl": "https://..."
}
```

or:

```json
{
  "redirectUrl": "https://..."
}
```

The current payment app already returns `data.redirectUrl`, so the storefront can
redirect successfully.

## FilixPay Documentation Sources

The FilixPay developer center is available at:

```text
https://your-filixpay-host/dashboard/developer
```

The Swagger UI loads the OpenAPI schema from:

```text
https://your-filixpay-host/openapi/v1/openapi
```

Relevant documented endpoints:

```text
POST https://your-filixpay-host/openapi/v1/orders
GET  https://your-filixpay-host/openapi/v1/orders/{merchantOrderId}/payment-token
GET  https://your-filixpay-host/openapi/v1/orders/{merchantOrderId}
GET  https://your-filixpay-host/openapi/v1/orders
```

Authentication uses OAuth2 client credentials:

```text
POST https://your-filixpay-host/auth/realms/your-realm/protocol/openid-connect/token
```

## Problem To Solve

`transaction-initialize-session.ts` still uses a hard-coded test checkout URL:

```ts
const filixCheckoutUrl = `https://your-filixpay-host/checkout?token=...`;
```

This must be replaced with a real FilixPay create-order call. The app should
create a FilixPay order for the current Saleor transaction, request a payment
token for that order, and return FilixPay's `payUrl` to Saleor.

## Required Flow

1. Storefront calls Saleor `transactionInitialize`.
2. Saleor sends `TRANSACTION_INITIALIZE_SESSION` to this app.
3. This app reads the Saleor webhook payload.
4. This app obtains a FilixPay OAuth access token using client credentials.
5. This app creates a FilixPay order with `POST /orders`.
6. This app requests a payment token with
   `GET /orders/{merchantOrderId}/payment-token`.
7. FilixPay returns `paymentToken`, `expiresIn`, and `payUrl`.
8. This app returns `CHARGE_ACTION_REQUIRED` to Saleor with `payUrl`.
9. Storefront redirects the customer to FilixPay.
10. FilixPay redirects the customer back to the Saleor/storefront `returnUrl`.
11. FilixPay server callback or active query updates the Saleor transaction state.
12. Storefront completes the checkout after Saleor shows the transaction is paid
    or authorized.

## Saleor Webhook Payload Fields

Use these fields from `ctx.payload` in
`src/pages/api/webhooks/transaction-initialize-session.ts`:

```ts
const { payload } = ctx;
const { actionType, amount, currency } = payload.action;
const returnUrl = payload.data?.returnUrl;
const saleorTransactionId = payload.transaction.id;
const saleorTransactionToken = payload.transaction.token;
const merchantReference = payload.merchantReference;
const idempotencyKey = payload.idempotencyKey;
```

Observed production payload example:

```json
{
  "data": {
    "event": {
      "includePspReference": true,
      "type": "CHARGE_ACTION_REQUIRED"
    },
    "returnUrl": "https://www.example.com/checkout?checkout=...&step=payment&processingPayment=filixpay"
  },
  "merchantReference": "VHJhbnNhY3Rpb25JdGVt...",
  "action": {
    "amount": 114.2,
    "currency": "USD",
    "actionType": "AUTHORIZATION"
  },
  "transaction": {
    "id": "VHJhbnNhY3Rpb25JdGVt...",
    "token": "2a64e8f2-9cc5-4949-b1e0-a8ee90ab7a2e",
    "pspReference": ""
  }
}
```

## FilixPay Authentication

FilixPay OpenAPI uses OAuth2 client credentials for server-to-server calls.
The client should cache the access token until shortly before expiry.

Token endpoint:

```http
POST https://your-filixpay-host/auth/realms/your-realm/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded
```

Request body:

```text
grant_type=client_credentials
client_id=<FILIXPAY_CLIENT_ID>
client_secret=<FILIXPAY_CLIENT_SECRET>
```

Use the returned `access_token` as:

```http
Authorization: Bearer <access_token>
```

## Create-Order API Contract

Implement a FilixPay client under:

```text
src/modules/filixpay/
```

Suggested files:

```text
src/modules/filixpay/client.ts
src/modules/filixpay/types.ts
```

Create a FilixPay order with:

```http
POST https://your-filixpay-host/openapi/v1/orders
Authorization: Bearer <access_token>
Content-Type: application/json
```

The documented create-order request schema is `OrderCreateRequest`.
For this Saleor payment app, map the webhook payload to the minimal required
FilixPay shape:

```ts
const createOrderRequest = {
  merchantOrderId: `SALEOR-${payload.transaction.token}`,
  subject: `Saleor transaction ${payload.merchantReference || payload.transaction.token}`,
  returnUrl,
  totalAmount: {
    currency,
    amount,
  },
  orderItems: [
    {
      productId: "saleor-transaction",
      productName: "Saleor checkout payment",
      quantity: 1,
      unitPrice: amount,
    },
  ],
};
```

Important details:

- `merchantOrderId` must match `^[0-9a-zA-Z_-]{1,100}$`.
- `orderItems` is required and must contain at least one item.
- The sum of item amounts must equal `totalAmount.amount`.
- `paymentExpiredAt`, customer fields, buyer fields, and split config are
  optional for the first integration pass.
- The Saleor `idempotencyKey` should still be logged and preserved, but FilixPay
  order idempotency can be achieved by reusing the same `merchantOrderId` based
  on `payload.transaction.token`.

## Payment Token API Contract

After creating the order, request a fresh payment token:

```http
GET https://your-filixpay-host/openapi/v1/orders/{merchantOrderId}/payment-token
Authorization: Bearer <access_token>
```

The documented successful response shape is wrapped in FilixPay's `ApiResponse`:

```json
{
  "success": true,
  "code": "SUCCESS",
  "message": "鏀粯浠ょ墝鐢熸垚鎴愬姛",
  "data": {
    "paymentToken": "ptk_abc123xyz789",
    "expiresIn": 300,
    "payUrl": "https://pay.your-filixpay-host?token=ptk_abc123xyz789"
  }
}
```

Normalize the create-order plus payment-token result to:

```ts
{
  merchantOrderId: string;
  tradeNo?: string;
  paymentToken: string;
  expiresIn: number;
  payUrl: string;
}
```

Then return to Saleor:

```ts
const successResponse: TransactionSessionSuccess = {
  pspReference: filixOrder.tradeNo || merchantOrderId,
  result: "CHARGE_ACTION_REQUIRED",
  message: "Redirect to FilixPay checkout",
  amount,
  externalUrl: filixPayment.payUrl,
  actions: [],
  data: {
    redirectUrl: filixPayment.payUrl,
    filixTradeNo: filixOrder.tradeNo,
    merchantOrderId,
    paymentTokenExpiresIn: filixPayment.expiresIn,
  },
};
```

## Environment Variables

Add required FilixPay configuration to `.env.example` and production runtime:

```env
FILIXPAY_API_BASE_URL=https://your-api-host/openapi/v1
FILIXPAY_TOKEN_URL=https://your-auth-host/realms/your-realm/protocol/openid-connect/token
FILIXPAY_CLIENT_ID=
FILIXPAY_CLIENT_SECRET=
FILIXPAY_WEBHOOK_SECRET=
```

Configure the payment notify webhook URL in **FilixPay Merchant Center** (not in
`.env`):

```text
https://pay.your-domain.com/api/webhooks/filixpay-notify
```

`FILIXPAY_WEBHOOK_SECRET` must match the secret configured in Merchant Center.

Do not commit real secrets.

## Payment Result Sync

Creating a FilixPay order only redirects the customer. It does not by itself mark
the Saleor transaction as paid.

Add a FilixPay notification endpoint, for example:

```text
src/pages/api/webhooks/filixpay-notify.ts
```

That endpoint should:

1. Verify the FilixPay signature.
2. Find the Saleor transaction using `merchantOrderId` or stored mapping.
3. Report a transaction event to Saleor using the app token from APL.
4. Return success to FilixPay only after Saleor accepts the update.

If FilixPay also redirects the browser back to `returnUrl`, keep the browser
return separate from server-to-server payment confirmation. Browser return is
for customer UX; server callback is the source of truth.

## FilixPay Webhook Verification

FilixPay sends webhook signatures in this header:

```http
X-FilixPay-Signature: sha256=<64 lowercase hex characters>
```

Verification rules:

1. Disable Next.js body parsing for the FilixPay webhook endpoint.
2. Read the raw request body bytes/string exactly as received.
3. Compute `HMAC-SHA256` using the endpoint-specific webhook secret.
4. Lowercase the hex digest and prefix it with `sha256=`.
5. Compare with `X-FilixPay-Signature` using a constant-time comparison.

Do not parse and re-stringify JSON before verification. Whitespace or key-order
changes will break the signature.

## Storage / Mapping

Persist at least this mapping:

```ts
{
  merchantOrderId: string;
  filixTradeNo?: string;
  saleorApiUrl: string;
  saleorTransactionId: string;
  saleorTransactionToken: string;
  amount: number;
  currency: string;
  status: "PENDING" | "PAID" | "FAILED";
}
```

The repository already has DynamoDB modules, but production currently uses
`APL=file` for app auth. Choose the simplest reliable storage available in
production. For a single-server deployment, a file or database table can work,
but avoid in-memory storage because Docker restarts would lose mappings.

## Implementation Tasks

1. Add FilixPay OAuth/OpenAPI env variables and validation.
2. Implement `getFilixPayAccessToken(...)` with token caching.
3. Implement `createFilixPayOrder(...)` using `POST /orders`.
4. Implement `getFilixPayPaymentToken(...)` using
   `GET /orders/{merchantOrderId}/payment-token`.
5. Replace the hard-coded checkout URL in
   `transaction-initialize-session.ts`.
6. Add idempotency handling by reusing `SALEOR-${payload.transaction.token}` as
   `merchantOrderId`.
7. Add FilixPay server callback endpoint.
8. Add Saleor transaction update/reporting after payment success.
9. Add tests for order payload mapping, payment-token response normalization,
   OAuth token handling, and webhook response shape.
10. Verify in production with Dashboard webhook deliveries and storefront
   checkout.

## Verification Checklist

Before considering the integration complete:

- `https://www.example.com/.well-known/jwks.json` returns JSON keys.
- Dashboard webhook delivery for `Transaction Initialize Session` is HTTP 200.
- Payment app logs show `Received transaction initialize webhook`.
- Payment app logs show successful FilixPay OAuth token retrieval without
  logging the token value.
- Payment app logs show successful FilixPay order creation.
- Payment app logs show successful FilixPay payment-token retrieval.
- Storefront redirects to a fresh FilixPay cashier URL.
- FilixPay payment success triggers the server callback.
- Saleor transaction becomes paid or authorized.
- Storefront can complete checkout and show the order confirmation.

## Known Non-Goals For This Step

- Do not change the storefront unless the returned data shape changes again.
- Do not rely on the hard-coded test FilixPay token.
- Do not mark Saleor paid from browser return alone.
- Do not log FilixPay client secrets, access tokens, webhook secrets, or full
  customer-sensitive payment payloads.

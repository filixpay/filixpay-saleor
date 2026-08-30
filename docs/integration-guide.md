# FilixPay × Saleor Integration Guide

This document explains how to deploy and wire up **filixpay-saleor** as a [Saleor Payment App](https://docs.saleor.io/docs/developer/payments#payment-app) with [FilixPay](https://www.filixpay.com).

Saleor does **not** use traditional “payment plugins.” Payments run through:

**Payment App + Transactions API + synchronous webhooks + FilixPay server notify**

---

## 1. What you are building

| Piece | Role |
|-------|------|
| **Saleor** | Checkout, orders, transaction state (source of truth) |
| **Storefront** | Calls `transactionInitialize`, redirects shopper to FilixPay |
| **filixpay-saleor** (this repo) | Saleor webhooks, FilixPay API, payment notify → Saleor `transactionEventReport` |
| **FilixPay** | Hosted checkout, card/wallet capture, `PAYMENT_SUCCESS` notify |

### App identity

| Field | Value |
|-------|-------|
| App ID | `com.filixpay.payment-app` |
| Manifest | `https://<your-app-domain>/api/manifest` |
| FilixPay notify URL | `https://<your-app-domain>/api/webhooks/filixpay-notify` |

> **Separate from commerce sync:** A manually created Saleor app used for product/catalog sync (`MANAGE_PRODUCTS`) is **not** this Payment App. Do not reuse its token for payments.

---

## 2. End-to-end payment flow

```text
Shopper → Storefront checkout
  → Saleor transactionInitialize (gateway: com.filixpay.payment-app)
  → Saleor sync webhook → <app>/api/webhooks/transaction-initialize-session
  → FilixPay create order / payment session → redirectUrl
  → Shopper pays on FilixPay

FilixPay PAYMENT_SUCCESS
  → POST <app>/api/webhooks/filixpay-notify (HMAC signed)
  → App finds Saleor transaction → transactionEventReport(CHARGE_SUCCESS)
  → Storefront completes checkout → order created
```

### Order ID mapping

FilixPay `merchantOrderId` is derived from the Saleor transaction token:

```text
merchantOrderId = SALEOR-{transaction.token}
```

Example: `SALEOR-2504a1ab-7fcb-41a0-8007-a403efc7826d` → token `2504a1ab-7fcb-41a0-8007-a403efc7826d`.

---

## 3. Prerequisites

- Node.js 24–26, pnpm 10+ (development)
- Saleor 3.22+ with Transactions API
- FilixPay merchant credentials (`FILIXPAY_CLIENT_ID`, `FILIXPAY_CLIENT_SECRET`)
- **Public HTTPS URL** for the Payment App (TLS termination at reverse proxy)
- DNS + TLS for a dedicated subdomain is recommended, e.g. `pay.example.com`

---

## 4. Configure environment variables

Copy [`.env.example`](../.env.example) to `.env`:

```env
# Public origin of this app (required behind reverse proxy)
APP_IFRAME_BASE_URL=https://pay.example.com
APP_API_BASE_URL=https://pay.example.com

# FilixPay OpenAPI (values from your FilixPay Merchant Center / developer docs)
FILIXPAY_API_BASE_URL=https://your-filixpay-host/openapi/v1
FILIXPAY_TOKEN_URL=https://your-filixpay-host/auth/realms/your-realm/protocol/openid-connect/token
FILIXPAY_CLIENT_ID=your-client-id
FILIXPAY_CLIENT_SECRET=your-client-secret

# Must match FilixPay Merchant Center webhook secret exactly
FILIXPAY_WEBHOOK_SECRET=your-webhook-secret

# Single-server Docker: persist app token after Dashboard install
APL=file
FILE_APL_PATH=/data/.auth-data.json
```

Never commit `.env`. Rotate secrets if they are ever exposed.

---

## 5. Run the app

### Docker (production)

```bash
docker compose build   # or pull a published image
docker compose up -d
```

Default bind: `127.0.0.1:3001` (expose only via reverse proxy).

Verify manifest:

```bash
curl -sS https://pay.example.com/api/manifest
```

All `targetUrl` / `tokenTargetUrl` fields must use your public `APP_API_BASE_URL`.

### Local development

```bash
pnpm install
pnpm dev
```

Use a tunnel (ngrok, Cloudflare Tunnel, etc.) and set `APP_*_BASE_URL` to the tunnel origin. See [Saleor local app development](https://docs.saleor.io/developer/extending/apps/local-app-development).

### Logs

```bash
docker compose logs --tail 100 -f
# or
docker logs filixpay-saleor --tail 100 -f
```

---

## 6. Reverse proxy (Nginx example)

Terminate TLS on `pay.example.com` and proxy to the container:

```nginx
server {
    listen 443 ssl http2;
    server_name pay.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    # Allow Saleor Dashboard to iframe the app UI
    add_header Content-Security-Policy "frame-ancestors https://example.com https://www.example.com;" always;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
    }
}
```

Replace `example.com` with your storefront / Saleor dashboard domain.

---

## 7. Install the app in Saleor Dashboard

1. Open your Saleor Dashboard → **Extensions** → **Add Extension** → **Install from manifest**
2. Manifest URL: `https://pay.example.com/api/manifest`
3. Grant permissions: `HANDLE_PAYMENTS`, `MANAGE_CHECKOUTS`, `MANAGE_ORDERS`
4. On success, Saleor calls `/api/register` and the app stores its token in APL

If a previous install failed, remove the app under **Extensions → Installed** and reinstall.

**Do not** use “Provide details manually” for this Payment App—that flow is for custom integration apps, not manifest-based payment apps.

---

## 8. FilixPay Merchant Center

In **Developer Center → Webhooks**:

| Setting | Value |
|---------|-------|
| Notify URL | `https://pay.example.com/api/webhooks/filixpay-notify` |
| Webhook secret | Same string as `FILIXPAY_WEBHOOK_SECRET` in `.env` |

### Signature verification

- Header: `X-FilixPay-Signature: sha256=<hex>`
- HMAC-SHA256 over the **raw request body** (see `src/modules/filixpay/notify.ts`)
- Do not re-serialize JSON before verifying

After changing `.env`, restart the container.

---

## 9. Saleor channel & storefront

1. **Configuration → Channels** → your channel → enable **FilixPay Payment App**
2. Storefront must use gateway id `com.filixpay.payment-app` when calling `transactionInitialize`

---

## 10. Infrastructure checklist (easy to miss)

### JWKS endpoint

Saleor webhook signature verification requires a valid JWKS at:

```text
https://<your-saleor-domain>/.well-known/jwks.json
```

If your reverse proxy serves a storefront 404 here, sync webhooks fail with `SIGNATURE_VERIFICATION_FAILED`.

### GraphQL WAF / rate limits

During **app install** and **filixpay-notify**, this app calls your Saleor GraphQL API from Node.js (`fetch`, `User-Agent: node`).

The Saleor App SDK sends the app token in the **`Authorization-Bearer`** header (Saleor also accepts standard `Authorization: Bearer`—see [Saleor authentication docs](https://docs.saleor.io/api-usage/authentication)).

If nginx or a CDN blocks:

- requests with `User-Agent: node`, or
- requests without a browser Referer, or
- the `Authorization-Bearer` header,

you may see:

| Symptom | Typical cause |
|---------|----------------|
| Dashboard: *could not be used to fetch app ID* | Install callback to GraphQL returns 403 |
| Logs: `[Network] Forbidden` on notify | Post-payment GraphQL call blocked |
| HTTP 500, `Failed to process notification` | Same as above |

**Mitigation (nginx example)** inside `location /graphql/`:

```nginx
# Allow Saleor App SDK (Authorization-Bearer header)
if ($http_authorization_bearer ~* ".+") {
    set $graphql_pass "Y";
}

# Allow node UA when a valid app token is present
set $block_node_ua 0;
if ($http_user_agent ~* "^node$") { set $block_node_ua 1; }
if ($http_authorization_bearer ~* ".+") { set $block_node_ua 0; }
if ($block_node_ua = 1) { return 403; }
```

Also allow loopback / Docker bridge IPs if the app runs on the same host as the proxy.

**Optional:** map your Saleor hostname to the host gateway in `docker-compose.yml` so the container does not reach GraphQL via an external CDN:

```yaml
extra_hosts:
  - "your-saleor-domain.example.com:host-gateway"
```

Reload nginx after changes: `nginx -t && nginx -s reload`.

### Verify GraphQL access

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  -X POST https://your-saleor-domain.example.com/graphql/ \
  -H "Content-Type: application/json" \
  -H "Authorization-Bearer: <APP_TOKEN_FROM_DASHBOARD>" \
  -d '{"query":"{ shop { name } }"}'
```

Expect `200`.

---

## 11. Verification checklist

- [ ] `GET /api/manifest` returns JSON with correct public URLs
- [ ] App shows as installed in Saleor Dashboard
- [ ] Channel lists FilixPay as a payment method
- [ ] Checkout redirects to FilixPay
- [ ] After payment, logs show `Processed FilixPay notification`
- [ ] Order shows paid / confirmed in storefront
- [ ] FilixPay webhook delivery status is **SUCCESS**

Success log example:

```json
{
  "message": "[filixpay-notify] Processed FilixPay notification",
  "eventType": "PAYMENT_SUCCESS",
  "merchantOrderId": "SALEOR-<transaction-token>",
  "alreadyProcessed": false
}
```

`alreadyProcessed: true` on retry is normal (idempotent).

---

## 12. Troubleshooting

| Symptom | HTTP / log | Fix |
|---------|------------|-----|
| Invalid webhook signature | 401, `Invalid FilixPay webhook signature` | Align `FILIXPAY_WEBHOOK_SECRET` with Merchant Center; restart app |
| Secret not configured | 500 | Set `FILIXPAY_WEBHOOK_SECRET` in `.env` |
| Forbidden on notify | 500, `[Network] Forbidden` | Unblock GraphQL for `Authorization-Bearer` (section 10) |
| App install fails | Dashboard install error | Same GraphQL WAF issue; check nginx logs |
| Transaction not found | 404 | Confirm app is installed, APL has token, `merchantOrderId` uses `SALEOR-{token}` |
| Manifest 520 / connection refused | CDN 520 | Container not listening on `:3001`; check proxy `proxy_pass` |
| Pay domain works, notify fails | 401 vs 500 | 401 = signature; 500 = usually Saleor GraphQL after signature passes |

---

## 13. Webhooks implemented by this app

Saleor → app (sync, registered via manifest):

- `PAYMENT_GATEWAY_INITIALIZE_SESSION`
- `TRANSACTION_INITIALIZE_SESSION`
- `TRANSACTION_PROCESS_SESSION`
- `TRANSACTION_CHARGE_REQUESTED`
- `TRANSACTION_REFUND_REQUESTED`
- `TRANSACTION_CANCELATION_REQUESTED`

FilixPay → app:

- `POST /api/webhooks/filixpay-notify`

---

## 14. Further reading

| Resource | Description |
|----------|-------------|
| [Saleor Payment App docs](https://docs.saleor.io/docs/developer/payments#payment-app) | Official Transactions API overview |
| [filixpay-order-integration.md](./filixpay-order-integration.md) | FilixPay OpenAPI details, implementation notes |
| [README.md](../README.md) | Quick start, CI / GHCR deploy |

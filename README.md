# FilixPay Saleor Payment App

Open-source [Saleor](https://saleor.io/) Payment App for [FilixPay](https://www.filixpay.com). It implements Saleor’s Transactions API webhooks and redirects shoppers to FilixPay Checkout for payment.

本仓库是开源的 Saleor 支付应用（Next.js）。商户自行托管后，Payment App 与 FilixPay 回调运行在**您自己的域名/服务**上；通过环境变量配置 Saleor 与 FilixPay 凭证即可部署。

## Documentation | 文档

| Document | Description |
|----------|-------------|
| **[docs/integration-guide.md](docs/integration-guide.md)** | **Integration guide** — deploy, Saleor install, FilixPay webhooks, reverse proxy, troubleshooting |
| [docs/filixpay-order-integration.md](docs/filixpay-order-integration.md) | FilixPay API & implementation details (contributors) |
| [docs/README.md](docs/README.md) | Documentation index |

## Features

- Saleor sync webhooks: `PAYMENT_GATEWAY_INITIALIZE_SESSION`, `TRANSACTION_INITIALIZE_SESSION`, `TRANSACTION_PROCESS_SESSION`
- Charge / refund / cancel request webhooks
- FilixPay OpenAPI: create order, payment token, HMAC-signed notify webhook
- APL support: file / Upstash / Saleor Cloud

## Prerequisites

- Node.js 24–26 and [pnpm](https://pnpm.io/) 10+
- A Saleor instance (3.22 schema)
- FilixPay merchant credentials (`FILIXPAY_CLIENT_ID` / `FILIXPAY_CLIENT_SECRET`)
- Public HTTPS URL for app webhooks and FilixPay notify callbacks

## Quick start (development)

```bash
cp .env.example .env
# Edit .env with your FilixPay credentials

pnpm install
pnpm dev
```

The app listens on [http://localhost:3000](http://localhost:3000) by default (Docker Compose maps `3001`).

Install the app from Saleor Dashboard → Apps, using your tunnel or public base URL.

## Docker

```bash
cp .env.example .env
# Fill FILIXPAY_* and APP_* URLs for your domain

docker compose build
docker compose up -d
```

Production tip: see [docs/integration-guide.md](docs/integration-guide.md) for reverse proxy, Saleor install, and FilixPay webhook setup.

## CI / production deploy (recommended)

GitHub Actions builds and pushes the image to GHCR on every push to `main`.

1. Repository **Settings → Actions → General → Workflow permissions** → **Read and write permissions**
2. If package push fails, add a classic PAT with `write:packages` as secret **`GHCR_TOKEN`**

On your server (public image — no GHCR login needed):

```bash
cd ~/filixpay-saleor
git pull origin main
./scripts/deploy-pull.sh
```

App runtime config stays in project `.env`. For private packages only, set
`DEPLOY_ENV_FILE` with `GHCR_USER` / `GHCR_TOKEN` (`read:packages`).

## Environment variables

See [`.env.example`](.env.example). Required for FilixPay:

| Variable | Purpose |
|----------|---------|
| `FILIXPAY_API_BASE_URL` | FilixPay OpenAPI base |
| `FILIXPAY_TOKEN_URL` | OAuth token endpoint |
| `FILIXPAY_CLIENT_ID` / `FILIXPAY_CLIENT_SECRET` | Merchant API credentials |
| `FILIXPAY_WEBHOOK_SECRET` | HMAC secret for notify verification (must match FilixPay Merchant Center) |

Register the payment notify webhook in **FilixPay Merchant Center** (not `.env`):

`https://<your-domain>/api/webhooks/filixpay-notify`

Optional: `APP_IFRAME_BASE_URL`, `APP_API_BASE_URL`, APL / DynamoDB settings.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Portions derived from [Saleor Dummy Payment App](https://github.com/saleor/dummy-payment-app) (BSD 3-Clause); attribution retained in NOTICE.

# FilixPay Payment Integration for Saleor

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/filixpay/filixpay-saleor?style=social)](https://github.com/filixpay/filixpay-saleor/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/filixpay/filixpay-saleor)](https://github.com/filixpay/filixpay-saleor/issues)

Open-source payment integration for Saleor Commerce, connecting Saleor checkout with FilixPay payment infrastructure.

Use FilixPay as a payment infrastructure layer for Saleor-based commerce applications.

[Website](https://www.filixpay.com) · [Integration guide](docs/integration-guide.md) · [Issues](https://github.com/filixpay/filixpay-saleor/issues)

## Features

- Saleor Commerce payment integration
- Payment checkout integration
- FilixPay payment infrastructure
- Global commerce payment flows
- Secure payment processing
- TypeScript-based integration
- Open source (Apache-2.0)

## Architecture

```text
Saleor Storefront
        │
        ▼
Saleor Checkout
        │
        ▼
FilixPay Saleor Integration
        │
        ▼
FilixPay Payment Infrastructure
        │
        ├── Payment Routing
        ├── Payment Runtime
        └── Payment Providers
```

The integration connects Saleor Commerce with FilixPay while keeping payment execution and accounting responsibilities inside FilixPay.

## Getting Started

Install and configure the integration according to the [documentation](docs/integration-guide.md).

```bash
cp .env.example .env
# Edit .env with your FilixPay credentials

pnpm install
pnpm dev
```

The app listens on [http://localhost:3000](http://localhost:3000) by default (Docker Compose maps `3001`).

Install the app from Saleor Dashboard → Apps, using your tunnel or public base URL.

## Why FilixPay?

FilixPay provides payment infrastructure for modern commerce applications, allowing commerce platforms such as Saleor to integrate with payment services without owning payment execution or accounting.

## Part of FilixPay

| Project | Role |
|---------|------|
| **[Merchant Portal](https://github.com/filixpay/filix-merchant)** | Merchant and commerce operations |
| **[Checkout](https://github.com/filixpay/filix-checkout)** | Customer-facing payment checkout |
| **[Saleor Integration](https://github.com/filixpay/filixpay-saleor)** | Payment integration for Saleor Commerce |

---

## Documentation

| Document | Description |
|----------|-------------|
| **[docs/integration-guide.md](docs/integration-guide.md)** | Deploy, Saleor install, FilixPay webhooks, reverse proxy, troubleshooting |
| [docs/filixpay-order-integration.md](docs/filixpay-order-integration.md) | FilixPay API and implementation details (contributors) |
| [docs/README.md](docs/README.md) | Documentation index |

This repository is an open-source Saleor Payment App (Next.js). After you self-host it, the Payment App and FilixPay callbacks run on **your own domain/service**. Configure Saleor and FilixPay credentials via environment variables.

本仓库是开源的 Saleor 支付应用（Next.js）。商户自行托管后，Payment App 与 FilixPay 回调运行在**您自己的域名/服务**上；通过环境变量配置 Saleor 与 FilixPay 凭证即可部署。

### Integration capabilities

- Saleor sync webhooks: `PAYMENT_GATEWAY_INITIALIZE_SESSION`, `TRANSACTION_INITIALIZE_SESSION`, `TRANSACTION_PROCESS_SESSION`
- Charge / refund / cancel request webhooks
- FilixPay OpenAPI: create order, payment token, HMAC-signed notify webhook
- APL support: file / Upstash / Saleor Cloud

### Prerequisites

- Node.js 24–26 and [pnpm](https://pnpm.io/) 10+
- A Saleor instance (3.22 schema)
- FilixPay merchant credentials (`FILIXPAY_CLIENT_ID` / `FILIXPAY_CLIENT_SECRET`)
- Public HTTPS URL for app webhooks and FilixPay notify callbacks

### Docker

```bash
cp .env.example .env
# Fill FILIXPAY_* and APP_* URLs for your domain

docker compose build
docker compose up -d
```

See [docs/integration-guide.md](docs/integration-guide.md) for reverse proxy, Saleor install, and FilixPay webhook setup.

### CI / production deploy

GitHub Actions builds and pushes the image to GHCR on every push to `main`.

```bash
cd ~/filixpay-saleor
git pull origin main
./scripts/deploy-pull.sh
```

### Environment variables

See [`.env.example`](.env.example). Required for FilixPay:

| Variable | Purpose |
|----------|---------|
| `FILIXPAY_API_BASE_URL` | FilixPay OpenAPI base |
| `FILIXPAY_TOKEN_URL` | OAuth token endpoint |
| `FILIXPAY_CLIENT_ID` / `FILIXPAY_CLIENT_SECRET` | Merchant API credentials |
| `FILIXPAY_WEBHOOK_SECRET` | HMAC secret for notify verification |

Register the payment notify webhook in **FilixPay Merchant Center**:

`https://<your-domain>/api/webhooks/filixpay-notify`

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Portions derived from [Saleor Dummy Payment App](https://github.com/saleor/dummy-payment-app) (BSD 3-Clause); attribution retained in NOTICE.

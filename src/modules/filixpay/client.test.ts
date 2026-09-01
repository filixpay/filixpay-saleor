import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCommercePaymentSessionPayload,
  buildCreateOrderPayload,
  buildMerchantOrderId,
  clearFilixPayAccessTokenCache,
  createFilixPayCheckout,
  createFilixPayCommercePaymentSession,
  getFilixPayAccessToken,
  getFilixPayPaymentToken,
  patchFilixPaySaleorOrderMetadata,
} from "./client";

const TEST_API_BASE_URL = "https://api.example.com/openapi/v1";
const TEST_TOKEN_URL =
  "https://auth.example.com/realms/your-realm/protocol/openid-connect/token";

const env = {
  FILIXPAY_API_BASE_URL: TEST_API_BASE_URL,
  FILIXPAY_TOKEN_URL: TEST_TOKEN_URL,
  FILIXPAY_CLIENT_ID: "client-id",
  FILIXPAY_CLIENT_SECRET: "client-secret",
  FILIXPAY_WEBHOOK_SECRET: "webhook-secret",
};

describe("FilixPay client", () => {
  beforeEach(() => {
    clearFilixPayAccessTokenCache();
  });
  it("builds stable merchant order IDs from Saleor transaction tokens", () => {
    expect(buildMerchantOrderId("2a64e8f2-9cc5-4949-b1e0-a8ee90ab7a2e")).toBe(
      "SALEOR-2a64e8f2-9cc5-4949-b1e0-a8ee90ab7a2e"
    );
  });

  it("maps Saleor transaction data into the documented FilixPay order payload", () => {
    expect(
      buildCreateOrderPayload({
        merchantOrderId: "SALEOR-token",
        amount: 114.2,
        currency: "USD",
        subject: "Saleor transaction token",
        returnUrl: "https://www.example.com/checkout",
      })
    ).toEqual({
      merchantOrderId: "SALEOR-token",
      subject: "Saleor transaction token",
      returnUrl: "https://www.example.com/checkout",
      totalAmount: {
        currency: "USD",
        amount: 114.2,
      },
      orderItems: [
        {
          productId: "saleor-transaction",
          productName: "Saleor checkout payment",
          quantity: 1,
          unitPrice: 114.2,
        },
      ],
    });
  });

  it("maps commerce checkout input into the payment session payload", () => {
    expect(
      buildCommercePaymentSessionPayload({
        saleorCheckoutId: "checkout-token",
        saleorTransactionToken: "txn-token",
        amount: 12,
        currency: "USD",
        returnUrl: "https://www.example.com/checkout/return",
        buyerEmail: "buyer@example.com",
        country: "US",
        lines: [
          {
            saleorProductId: "prod-1",
            saleorVariantId: "var-1",
            quantity: 1,
          },
        ],
      })
    ).toEqual({
      saleorCheckoutId: "checkout-token",
      saleorTransactionToken: "txn-token",
      amount: 12,
      currency: "USD",
      returnUrl: "https://www.example.com/checkout/return",
      buyer: {
        email: "buyer@example.com",
      },
      country: "US",
      lines: [
        {
          saleorProductId: "prod-1",
          saleorVariantId: "var-1",
          quantity: 1,
        },
      ],
    });
  });

  it("gets an OAuth access token with client credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: "access-token",
          expires_in: 300,
          token_type: "Bearer",
        }),
    });

    await expect(getFilixPayAccessToken(env, fetchMock)).resolves.toMatchObject({
      accessToken: "access-token",
      expiresIn: 300,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      env.FILIXPAY_TOKEN_URL,
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      })
    );
    expect(fetchMock.mock.calls[0][1].body.toString()).toBe(
      "grant_type=client_credentials&client_id=client-id&client_secret=client-secret"
    );
  });

  it("reuses an unexpired OAuth access token for the same client", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: "cached-access-token",
          expires_in: 300,
        }),
    });
    const cacheEnv = {
      ...env,
      FILIXPAY_CLIENT_ID: "cache-client-id",
    };

    await getFilixPayAccessToken(cacheEnv, fetchMock);
    await expect(getFilixPayAccessToken(cacheEnv, fetchMock)).resolves.toMatchObject({
      accessToken: "cached-access-token",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gets a payment token and payUrl for a merchant order", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          success: true,
          code: "SUCCESS",
          message: "鏀粯浠ょ墝鐢熸垚鎴愬姛",
          data: {
            paymentToken: "ptk_abc123xyz789",
            expiresIn: 300,
            payUrl: "https://checkout.example.com?token=ptk_abc123xyz789",
          },
        }),
    });

    await expect(
      getFilixPayPaymentToken("SALEOR-token", "access-token", env, fetchMock)
    ).resolves.toEqual({
      merchantOrderId: "SALEOR-token",
      paymentToken: "ptk_abc123xyz789",
      expiresIn: 300,
      payUrl: "https://checkout.example.com?token=ptk_abc123xyz789",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_API_BASE_URL}/orders/SALEOR-token/payment-token`,
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: "Bearer access-token",
        },
      })
    );
  });

  it("creates an order, then gets the payment token payUrl", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: "access-token",
            expires_in: 300,
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            success: true,
            code: "SUCCESS",
            data: {
              merchantOrderId: "SALEOR-token",
              tradeNo: "FT202605140003",
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            success: true,
            code: "SUCCESS",
            data: {
              paymentToken: "ptk_def",
              expiresIn: 300,
              payUrl: "https://checkout.example.com?token=ptk_def",
            },
          }),
      });

    await expect(
      createFilixPayCheckout(
        {
          merchantOrderId: "SALEOR-token",
          amount: 12,
          currency: "USD",
          subject: "Saleor transaction token",
          returnUrl: "https://www.example.com/checkout",
        },
        {
          ...env,
          FILIXPAY_CLIENT_ID: "checkout-client-id",
        },
        fetchMock
      )
    ).resolves.toEqual({
      merchantOrderId: "SALEOR-token",
      tradeNo: "FT202605140003",
      paymentToken: "ptk_def",
      expiresIn: 300,
      payUrl: "https://checkout.example.com?token=ptk_def",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${TEST_API_BASE_URL}/orders`,
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer access-token",
          "Content-Type": "application/json",
        },
      })
    );
  });

  it("creates a commerce payment session and returns redirectUrl", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: "access-token",
            expires_in: 300,
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            success: true,
            code: "SUCCESS",
            data: {
              orderId: "00000000-0000-4000-8000-000000000001",
              merchantOrderId: "SALEOR-txn-token",
              redirectUrl: "https://checkout.example.com?token=ptk_commerce",
              expiresAt: "2026-08-28T12:00:00Z",
              idempotencyReplay: false,
            },
          }),
      });

    await expect(
      createFilixPayCommercePaymentSession(
        {
          saleorCheckoutId: "checkout-token",
          saleorTransactionToken: "txn-token",
          amount: 12,
          currency: "USD",
          returnUrl: "https://www.example.com/checkout/return",
          buyerEmail: "buyer@example.com",
          lines: [
            {
              saleorProductId: "prod-1",
              saleorVariantId: "var-1",
              quantity: 1,
            },
          ],
        },
        env,
        fetchMock
      )
    ).resolves.toEqual({
      orderId: "00000000-0000-4000-8000-000000000001",
      merchantOrderId: "SALEOR-txn-token",
      redirectUrl: "https://checkout.example.com?token=ptk_commerce",
      expiresAt: "2026-08-28T12:00:00Z",
      idempotencyReplay: false,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${TEST_API_BASE_URL}/commerce/saleor/payment-sessions`,
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer access-token",
          "Content-Type": "application/json",
        },
      })
    );
  });

  it("patches FilixPay order with Saleor order metadata", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: "access-token",
            expires_in: 300,
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            success: true,
            code: "SUCCESS",
            data: null,
            message: "Saleor order metadata updated",
          }),
      });

    await expect(
      patchFilixPaySaleorOrderMetadata(
        {
          filixPayOrderId: "00000000-0000-4000-8000-000000000001",
          saleorOrderId: "T3JkZXI6MQ==",
          saleorOrderNumber: "1234",
        },
        env,
        fetchMock
      )
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${TEST_API_BASE_URL}/commerce/saleor/orders/00000000-0000-4000-8000-000000000001/saleor-metadata`,
      expect.objectContaining({
        method: "PATCH",
        headers: {
          Authorization: "Bearer access-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          saleorOrderId: "T3JkZXI6MQ==",
          saleorOrderNumber: "1234",
        }),
      })
    );
  });
});

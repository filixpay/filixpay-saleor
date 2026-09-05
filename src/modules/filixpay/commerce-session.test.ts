import { describe, expect, it } from "vitest";
import { extractCommercePaymentSessionInput } from "./commerce-session";

const basePayload = {
  __typename: "TransactionInitializeSession" as const,
  idempotencyKey: "idem-1",
  merchantReference: "ref-1",
  data: {
    returnUrl: "https://www.example.com/checkout/return",
  },
  action: {
    __typename: "TransactionProcessAction" as const,
    amount: 42.5,
    currency: "USD",
    actionType: "CHARGE" as const,
  },
  transaction: {
    __typename: "TransactionItem" as const,
    id: "txn-id",
    token: "2a64e8f2-9cc5-4949-b1e0-a8ee90ab7a2e",
    pspReference: "psp-1",
    events: [],
  },
};

describe("extractCommercePaymentSessionInput", () => {
  it("returns null when sourceObject is missing", () => {
    expect(extractCommercePaymentSessionInput(basePayload as never)).toBeNull();
  });

  it("maps a single-line checkout into commerce payment session input", () => {
    const input = extractCommercePaymentSessionInput({
      ...basePayload,
      sourceObject: {
        __typename: "Checkout",
        token: "checkout-token-1",
        email: "buyer@example.com",
        billingAddress: {
          country: {
            code: "US",
          },
        },
        lines: [
          {
            quantity: 1,
            unitPrice: {
              gross: {
                amount: 42.5,
              },
            },
            variant: {
              id: "UHJvZHVjdFZhcmlhbnQ6MQ==",
              name: "Large",
              sku: "TEE-LG",
              product: {
                id: "UHJvZHVjdDox",
                name: "Filix Tee",
              },
            },
          },
        ],
      },
    } as never);

    expect(input).toEqual({
      saleorCheckoutId: "checkout-token-1",
      saleorTransactionToken: "2a64e8f2-9cc5-4949-b1e0-a8ee90ab7a2e",
      amount: 42.5,
      currency: "USD",
      returnUrl: "https://www.example.com/checkout/return",
      buyerEmail: "buyer@example.com",
      country: "US",
      lines: [
        {
          saleorProductId: "UHJvZHVjdDox",
          saleorVariantId: "UHJvZHVjdFZhcmlhbnQ6MQ==",
          quantity: 1,
          productName: "Filix Tee (Large)",
          sku: "TEE-LG",
          unitPrice: 42.5,
        },
      ],
    });
  });

  it("rejects multi-line checkouts for V1", () => {
    expect(() =>
      extractCommercePaymentSessionInput({
        ...basePayload,
        sourceObject: {
          __typename: "Checkout",
          token: "checkout-token-1",
          email: "buyer@example.com",
          lines: [
            {
              quantity: 1,
              unitPrice: {
                gross: {
                  amount: 10,
                },
              },
              variant: {
                id: "var-1",
                name: "A",
                sku: "A-1",
                product: { id: "prod-1", name: "Product A" },
              },
            },
            {
              quantity: 1,
              unitPrice: {
                gross: {
                  amount: 20,
                },
              },
              variant: {
                id: "var-2",
                name: "B",
                sku: "B-1",
                product: { id: "prod-2", name: "Product B" },
              },
            },
          ],
        },
      } as never)
    ).toThrow("exactly one checkout line");
  });
});

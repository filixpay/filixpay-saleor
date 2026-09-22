import { describe, expect, it, vi } from "vitest";
import { syncPaidFilixOrderToSaleor } from "../sync-payment";
import type { SyncPaymentDeps } from "../sync-payment.types";
import type { PushCompleteTransactionSnapshot } from "../push-complete.types";

const TOKEN = "1b32e8df-2b2b-487e-a7c5-d7b1aead999b";
const FILIX_ORDER_ID = `SALEOR-${TOKEN}`;

function unpaidTransaction(
  overrides: Partial<PushCompleteTransactionSnapshot> = {}
): PushCompleteTransactionSnapshot {
  return {
    id: "txn-1",
    token: TOKEN,
    chargedAmount: { amount: 0, currency: "USD" },
    authorizedAmount: { amount: 0, currency: "USD" },
    checkout: {
      id: "Q2hlY2tvdXQ6MQ==",
      chargeStatus: "NONE",
      authorizeStatus: "NONE",
      totalPrice: { gross: { amount: 1.99, currency: "USD" } },
    },
    order: null,
    ...overrides,
  };
}

function mockDeps(options: {
  transaction?: PushCompleteTransactionSnapshot | null;
  paid?: "paid" | "not_paid";
  amount?: number;
  reportError?: Error;
}): SyncPaymentDeps & {
  lookupTransaction: ReturnType<typeof vi.fn>;
  fetchPaidOrder: ReturnType<typeof vi.fn>;
  reportChargeSuccess: ReturnType<typeof vi.fn>;
} {
  return {
    lookupTransaction: vi.fn(async () => options.transaction ?? null),
    fetchPaidOrder: vi.fn(async () => {
      if (options.paid === "not_paid") {
        return { status: "not_paid" as const };
      }
      return {
        status: "paid" as const,
        order: {
          amount: options.amount ?? 1.99,
          currency: "USD",
          tradeNo: "FP-TRADE-1",
        },
      };
    }),
    reportChargeSuccess: vi.fn(async () => {
      if (options.reportError) {
        throw options.reportError;
      }
    }),
  };
}

describe("syncPaidFilixOrderToSaleor", () => {
  it("returns already_paid when Saleor checkout is FULL", async () => {
    const deps = mockDeps({
      transaction: unpaidTransaction({
        checkout: {
          id: "Q2hlY2tvdXQ6MQ==",
          chargeStatus: "FULL",
          authorizeStatus: "NONE",
          totalPrice: { gross: { amount: 1.99, currency: "USD" } },
        },
      }),
    });

    const result = await syncPaidFilixOrderToSaleor(FILIX_ORDER_ID, deps);

    expect(result.status).toBe("already_paid");
    expect(deps.fetchPaidOrder).not.toHaveBeenCalled();
    expect(deps.reportChargeSuccess).not.toHaveBeenCalled();
  });

  it("reports CHARGE_SUCCESS when Filix order is paid", async () => {
    const deps = mockDeps({ transaction: unpaidTransaction(), paid: "paid" });

    const result = await syncPaidFilixOrderToSaleor(TOKEN, deps);

    expect(result).toEqual({
      status: "synced",
      filixOrderId: FILIX_ORDER_ID,
      saleorTransactionId: "txn-1",
      pspReference: "FP-TRADE-1",
    });
    expect(deps.reportChargeSuccess).toHaveBeenCalledWith({
      transaction: expect.objectContaining({ id: "txn-1" }),
      amount: 1.99,
      tradeNo: "FP-TRADE-1",
      filixOrderId: FILIX_ORDER_ID,
    });
  });

  it("returns not_paid when Filix order is unpaid", async () => {
    const deps = mockDeps({ transaction: unpaidTransaction(), paid: "not_paid" });

    const result = await syncPaidFilixOrderToSaleor(FILIX_ORDER_ID, deps);

    expect(result.status).toBe("not_paid");
    expect(deps.reportChargeSuccess).not.toHaveBeenCalled();
  });

  it("returns not_found when Saleor transaction is missing", async () => {
    const deps = mockDeps({ transaction: null });

    const result = await syncPaidFilixOrderToSaleor(FILIX_ORDER_ID, deps);

    expect(result.status).toBe("not_found");
  });

  it("returns amount_mismatch when Filix amount differs from checkout total", async () => {
    const deps = mockDeps({
      transaction: unpaidTransaction(),
      paid: "paid",
      amount: 9.99,
    });

    const result = await syncPaidFilixOrderToSaleor(FILIX_ORDER_ID, deps);

    expect(result.status).toBe("amount_mismatch");
    expect(deps.reportChargeSuccess).not.toHaveBeenCalled();
  });
});

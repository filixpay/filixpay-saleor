import { describe, expect, it, vi } from "vitest";
import { pushCompletePaidCheckout } from "../push-complete";
import type {
  PushCompleteDeps,
  PushCompleteTransactionSnapshot,
} from "../push-complete.types";

const FILIX_ORDER_ID = "SALEOR-1b32e8df-2b2b-487e-a7c5-d7b1aead999b";
const TOKEN = "1b32e8df-2b2b-487e-a7c5-d7b1aead999b";

function mockDeps(options: {
  transaction?: PushCompleteTransactionSnapshot | null;
  afterSync?: PushCompleteTransactionSnapshot | null;
  complete?: Awaited<ReturnType<PushCompleteDeps["checkoutComplete"]>>;
  syncError?: Error;
}): PushCompleteDeps & {
  syncPayment: ReturnType<typeof vi.fn>;
  checkoutComplete: ReturnType<typeof vi.fn>;
  lookupTransaction: ReturnType<typeof vi.fn>;
} {
  let lookups = 0;
  const lookupTransaction = vi.fn(async () => {
    lookups += 1;
    if (lookups === 1) {
      return options.transaction ?? null;
    }
    return options.afterSync ?? options.transaction ?? null;
  });

  const syncPayment = vi.fn(async () => {
    if (options.syncError) {
      throw options.syncError;
    }
  });

  const checkoutComplete = vi.fn(async () => options.complete ?? { order: null, errors: [] });

  return {
    lookupTransaction,
    syncPayment,
    checkoutComplete,
    isTransactionPaid: () => false,
  };
}

describe("pushCompletePaidCheckout", () => {
  it("returns already_completed when Saleor order already exists", async () => {
    const deps = mockDeps({
      transaction: {
        id: "txn-1",
        order: { id: "T3JkZXI6MQ==", number: "1001" },
        checkout: {
          id: "Q2hlY2tvdXQ6MQ==",
          chargeStatus: "FULL",
          authorizeStatus: "NONE",
        },
      },
    });

    const result = await pushCompletePaidCheckout(FILIX_ORDER_ID, deps);

    expect(result).toEqual({
      status: "already_completed",
      filixOrderId: FILIX_ORDER_ID,
      saleorOrderNumber: "1001",
      saleorOrderId: "T3JkZXI6MQ==",
      steps: { paymentSynced: false, checkoutCompleted: false },
    });
    expect(deps.checkoutComplete).not.toHaveBeenCalled();
    expect(deps.syncPayment).not.toHaveBeenCalled();
  });

  it("completes when checkout is already FULL", async () => {
    const deps = mockDeps({
      transaction: {
        id: "txn-1",
        token: TOKEN,
        checkout: {
          id: "Q2hlY2tvdXQ6MQ==",
          chargeStatus: "FULL",
          authorizeStatus: "NONE",
        },
        order: null,
      },
      complete: {
        order: { id: "T3JkZXI6Mg==", number: "1002" },
        errors: [],
      },
    });

    const result = await pushCompletePaidCheckout(FILIX_ORDER_ID, deps);

    expect(result.status).toBe("completed");
    expect(result.saleorOrderNumber).toBe("1002");
    expect(result.steps).toEqual({ paymentSynced: false, checkoutCompleted: true });
    expect(deps.syncPayment).not.toHaveBeenCalled();
    expect(deps.checkoutComplete).toHaveBeenCalledWith("Q2hlY2tvdXQ6MQ==");
  });

  it("syncs payment then completes when not FULL initially", async () => {
    const unpaid: PushCompleteTransactionSnapshot = {
      id: "txn-1",
      token: TOKEN,
      checkout: {
        id: "Q2hlY2tvdXQ6MQ==",
        chargeStatus: "NONE",
        authorizeStatus: "NONE",
      },
      order: null,
    };
    const paid: PushCompleteTransactionSnapshot = {
      ...unpaid,
      checkout: {
        id: "Q2hlY2tvdXQ6MQ==",
        chargeStatus: "FULL",
        authorizeStatus: "NONE",
      },
    };
    const deps = mockDeps({
      transaction: unpaid,
      afterSync: paid,
      complete: {
        order: { id: "T3JkZXI6Mw==", number: "1003" },
        errors: [],
      },
    });

    const result = await pushCompletePaidCheckout(TOKEN, deps);

    expect(result.status).toBe("completed");
    expect(result.filixOrderId).toBe(FILIX_ORDER_ID);
    expect(result.steps).toEqual({ paymentSynced: true, checkoutCompleted: true });
    expect(deps.syncPayment).toHaveBeenCalledTimes(1);
    expect(deps.checkoutComplete).toHaveBeenCalledWith("Q2hlY2tvdXQ6MQ==");
  });

  it("fails PAYMENT_NOT_SETTLED and never completes when sync leaves unpaid", async () => {
    const unpaid: PushCompleteTransactionSnapshot = {
      id: "txn-1",
      checkout: {
        id: "Q2hlY2tvdXQ6MQ==",
        chargeStatus: "PARTIAL",
        authorizeStatus: "NONE",
      },
      order: null,
    };
    const deps = mockDeps({
      transaction: unpaid,
      afterSync: unpaid,
    });

    const result = await pushCompletePaidCheckout(FILIX_ORDER_ID, deps);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("PAYMENT_NOT_SETTLED");
    expect(result.steps.paymentSynced).toBe(true);
    expect(deps.checkoutComplete).not.toHaveBeenCalled();
  });

  it("fails CHECKOUT_GONE when paid but checkout missing", async () => {
    const deps = mockDeps({
      transaction: {
        id: "txn-1",
        chargedAmount: { amount: 10, currency: "USD" },
        checkout: null,
        order: null,
      },
    });
    deps.isTransactionPaid = () => true;

    const result = await pushCompletePaidCheckout(FILIX_ORDER_ID, deps);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("CHECKOUT_GONE");
    expect(deps.checkoutComplete).not.toHaveBeenCalled();
  });

  it("maps INSUFFICIENT_STOCK from checkoutComplete", async () => {
    const deps = mockDeps({
      transaction: {
        id: "txn-1",
        checkout: {
          id: "Q2hlY2tvdXQ6MQ==",
          chargeStatus: "FULL",
          authorizeStatus: "NONE",
        },
        order: null,
      },
      complete: {
        order: null,
        errors: [{ code: "INSUFFICIENT_STOCK", message: "Insufficient product stock" }],
      },
    });

    const result = await pushCompletePaidCheckout(FILIX_ORDER_ID, deps);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("INSUFFICIENT_STOCK");
    expect(result.steps.checkoutCompleted).toBe(false);
  });

  it("maps CHECKOUT_NOT_FULLY_PAID from checkoutComplete", async () => {
    const deps = mockDeps({
      transaction: {
        id: "txn-1",
        checkout: {
          id: "Q2hlY2tvdXQ6MQ==",
          chargeStatus: "FULL",
          authorizeStatus: "NONE",
        },
        order: null,
      },
      complete: {
        order: null,
        errors: [{ code: "CHECKOUT_NOT_FULLY_PAID", message: "Checkout is not fully paid" }],
      },
    });

    const result = await pushCompletePaidCheckout(FILIX_ORDER_ID, deps);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("CHECKOUT_NOT_FULLY_PAID");
  });

  it("returns NOT_ELIGIBLE when transaction is missing", async () => {
    const deps = mockDeps({ transaction: null });

    const result = await pushCompletePaidCheckout(FILIX_ORDER_ID, deps);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("NOT_ELIGIBLE");
    expect(deps.syncPayment).not.toHaveBeenCalled();
    expect(deps.checkoutComplete).not.toHaveBeenCalled();
  });

  it("does not complete when syncPayment throws", async () => {
    const unpaid: PushCompleteTransactionSnapshot = {
      id: "txn-1",
      checkout: {
        id: "Q2hlY2tvdXQ6MQ==",
        chargeStatus: "NONE",
        authorizeStatus: "NONE",
      },
      order: null,
    };
    const deps = mockDeps({
      transaction: unpaid,
      syncError: new Error("Filix order not paid"),
    });

    const result = await pushCompletePaidCheckout(FILIX_ORDER_ID, deps);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("INTERNAL");
    expect(deps.checkoutComplete).not.toHaveBeenCalled();
  });
});

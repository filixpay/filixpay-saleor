import { describe, expect, it, vi } from "vitest";
import { tryDeepPackGrantAfterChargeSuccess } from "./orchestrate";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("tryDeepPackGrantAfterChargeSuccess", () => {
  it("skips when CMS config missing", async () => {
    const logger = createLogger();
    const fetchOrder = vi.fn();
    await tryDeepPackGrantAfterChargeSuccess({
      tradeNo: "TN1",
      merchantOrderId: "SALEOR-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      logger,
      getConfig: () => null,
      fetchOrder,
      postConfirmed: vi.fn(),
      sleep: vi.fn(),
      poll: { attempts: 3, baseDelayMs: 1 },
    });
    expect(fetchOrder).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  it("WARNs and does not POST when order never appears", async () => {
    const logger = createLogger();
    const postConfirmed = vi.fn();
    await tryDeepPackGrantAfterChargeSuccess({
      tradeNo: "TN1",
      merchantOrderId: "SALEOR-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      logger,
      getConfig: () => ({ cmsBaseUrl: "https://cms.example.com", secret: "s" }),
      fetchOrder: vi.fn().mockResolvedValue({ order: null, checkoutId: "chk_1" }),
      postConfirmed,
      sleep: vi.fn().mockResolvedValue(undefined),
      poll: { attempts: 2, baseDelayMs: 1 },
    });
    expect(postConfirmed).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Order"),
      expect.objectContaining({
        paymentEventId: "TN1",
        checkoutId: "chk_1",
      })
    );
  });

  it("POSTs once for an eligible OrderLine", async () => {
    const logger = createLogger();
    const postConfirmed = vi.fn().mockResolvedValue({ ok: true, kind: "fulfilled" });
    await tryDeepPackGrantAfterChargeSuccess({
      tradeNo: "TN1",
      merchantOrderId: "SALEOR-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      logger,
      getConfig: () => ({ cmsBaseUrl: "https://cms.example.com", secret: "s" }),
      fetchOrder: vi.fn().mockResolvedValue({
        order: {
          id: "T3JkZXI6OTk5",
          user: { id: "VXNlcjo5OTk=" },
          lines: [
            {
              id: "T3JkZXJMaW5lOjk5OQ==",
              metadata: [{ key: "readingId", value: "782479dd-4dcb-4d41-bd2b-6e1407b6a399" }],
              variant: { sku: "ICHING-DEEP-199" },
            },
          ],
        },
        checkoutId: null,
      }),
      postConfirmed,
      sleep: vi.fn(),
      poll: { attempts: 1, baseDelayMs: 1 },
    });
    expect(postConfirmed).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalled();
  });

  it("logs ERROR for DEEP_PACK_ALREADY_OWNED without throwing", async () => {
    const logger = createLogger();
    await tryDeepPackGrantAfterChargeSuccess({
      tradeNo: "TN1",
      merchantOrderId: "SALEOR-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      logger,
      getConfig: () => ({ cmsBaseUrl: "https://cms.example.com", secret: "s" }),
      fetchOrder: vi.fn().mockResolvedValue({
        order: {
          id: "T3JkZXI6OTk5",
          user: { id: "VXNlcjo5OTk=" },
          lines: [
            {
              id: "T3JkZXJMaW5lOjk5OQ==",
              metadata: [{ key: "readingId", value: "782479dd-4dcb-4d41-bd2b-6e1407b6a399" }],
              variant: { sku: "ICHING-DEEP-199" },
            },
          ],
        },
        checkoutId: null,
      }),
      postConfirmed: vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        code: "DEEP_PACK_ALREADY_OWNED",
        message: "owned",
      }),
      sleep: vi.fn(),
      poll: { attempts: 1, baseDelayMs: 1 },
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("DEEP_PACK_ALREADY_OWNED"),
      expect.anything()
    );
  });
});

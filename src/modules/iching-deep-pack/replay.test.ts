import { describe, expect, it, vi } from "vitest";
import { runDeepPackReplay } from "./replay";

describe("runDeepPackReplay", () => {
  it("returns order_not_ready when order missing", async () => {
    const result = await runDeepPackReplay({
      tradeNo: "TN1",
      merchantOrderId: "SALEOR-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getConfig: () => ({ cmsBaseUrl: "https://cms.example.com", secret: "s" }),
      fetchOrder: vi.fn().mockResolvedValue({ order: null, checkoutId: "chk" }),
      postConfirmed: vi.fn(),
    });
    expect(result.status).toBe("order_not_ready");
  });

  it("grants when order present", async () => {
    const postConfirmed = vi.fn().mockResolvedValue({ ok: true, kind: "replayed" });
    const result = await runDeepPackReplay({
      tradeNo: "TN1",
      merchantOrderId: "SALEOR-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
    });
    expect(result.status).toBe("ok");
    expect(postConfirmed).toHaveBeenCalled();
  });
});

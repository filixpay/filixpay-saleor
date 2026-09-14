import { describe, expect, it, vi } from "vitest";
import { waitForSaleorOrder } from "./wait-for-order";

describe("waitForSaleorOrder", () => {
  it("returns order on first fetch when present", async () => {
    const order = { id: "T3JkZXI6OTk5", user: { id: "VXNlcjo5OTk=" }, lines: [] };
    const fetchOrder = vi.fn().mockResolvedValue({ order, checkoutId: "chk_1" });
    const sleep = vi.fn();

    const result = await waitForSaleorOrder({
      fetchOrder,
      sleep,
      attempts: 5,
      baseDelayMs: 2000,
    });

    expect(result).toEqual({ order, checkoutId: "chk_1" });
    expect(fetchOrder).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries until order appears then returns it", async () => {
    const order = { id: "T3JkZXI6OTk5", user: { id: "VXNlcjo5OTk=" }, lines: [] };
    const fetchOrder = vi
      .fn()
      .mockResolvedValueOnce({ order: null, checkoutId: "chk_1" })
      .mockResolvedValueOnce({ order, checkoutId: "chk_1" });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await waitForSaleorOrder({
      fetchOrder,
      sleep,
      attempts: 5,
      baseDelayMs: 2000,
    });

    expect(result?.order).toEqual(order);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("returns null after exhausting attempts", async () => {
    const fetchOrder = vi.fn().mockResolvedValue({ order: null, checkoutId: "chk_1" });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await waitForSaleorOrder({
      fetchOrder,
      sleep,
      attempts: 3,
      baseDelayMs: 10,
    });

    expect(result).toBeNull();
    expect(fetchOrder).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });
});

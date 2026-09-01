import { describe, expect, it } from "vitest";
import {
  isFilixPayOrderUuid,
  resolveSaleorMetadataPatchTarget,
} from "./saleor-metadata-patch";

describe("saleor-metadata-patch", () => {
  it("accepts FilixPay order UUIDs", () => {
    expect(isFilixPayOrderUuid("01a05149-baa0-77f7-ae36-023172544a05")).toBe(true);
    expect(isFilixPayOrderUuid("SALEOR-01a05149-baa0-77f7-ae36-023172544a05")).toBe(false);
    expect(isFilixPayOrderUuid("2026051403946329234091762737")).toBe(false);
  });

  it("resolves a PATCH target when pspReference is FilixPay order UUID and Saleor order exists", () => {
    expect(
      resolveSaleorMetadataPatchTarget({
        pspReference: "01a05149-baa0-77f7-ae36-023172544a05",
        saleorOrderId: "T3JkZXI6MQ==",
        saleorOrderNumber: "1234",
      })
    ).toEqual({
      filixPayOrderId: "01a05149-baa0-77f7-ae36-023172544a05",
      saleorOrderId: "T3JkZXI6MQ==",
      saleorOrderNumber: "1234",
    });
  });

  it("returns null when Saleor order is missing (checkout not converted yet)", () => {
    expect(
      resolveSaleorMetadataPatchTarget({
        pspReference: "01a05149-baa0-77f7-ae36-023172544a05",
        saleorOrderId: null,
      })
    ).toBeNull();
  });

  it("returns null for legacy tradeNo pspReference", () => {
    expect(
      resolveSaleorMetadataPatchTarget({
        pspReference: "2026051403946329234091762737",
        saleorOrderId: "T3JkZXI6MQ==",
      })
    ).toBeNull();
  });
});

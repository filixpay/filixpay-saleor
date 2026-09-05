import { describe, expect, it } from "vitest";
import { normalizeFilixOrderId, parseTransactionToken } from "../order-id";

describe("Filix order id helpers", () => {
  it("normalize adds SALEOR- prefix", () => {
    expect(normalizeFilixOrderId("1b32e8df-2b2b-487e-a7c5-d7b1aead999b")).toBe(
      "SALEOR-1b32e8df-2b2b-487e-a7c5-d7b1aead999b"
    );
  });

  it("normalize is idempotent", () => {
    const id = "SALEOR-1b32e8df-2b2b-487e-a7c5-d7b1aead999b";
    expect(normalizeFilixOrderId(id)).toBe(id);
  });

  it("parse strips SALEOR- prefix", () => {
    expect(parseTransactionToken("SALEOR-1b32e8df-2b2b-487e-a7c5-d7b1aead999b")).toBe(
      "1b32e8df-2b2b-487e-a7c5-d7b1aead999b"
    );
  });

  it("parse accepts bare uuid after normalize", () => {
    expect(parseTransactionToken("1b32e8df-2b2b-487e-a7c5-d7b1aead999b")).toBe(
      "1b32e8df-2b2b-487e-a7c5-d7b1aead999b"
    );
  });
});

import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import {
  getTransactionTokenFromMerchantOrderId,
  mapFilixPayEventToSaleorEvent,
  parseFilixPayNotification,
  verifyFilixPaySignature,
} from "./notify";

const payload = {
  data: {
    amount: 126.19,
    paidAt: "2026-05-14T07:36:27.250918001Z",
    tradeNo: "2026051403946329234091762737",
    currency: "USD",
    merchantOrderId: "SALEOR-2504a1ab-7fcb-41a0-8007-a403efc7826d",
    channelTransactionId: "pi_3TWtoj2NyJoL2KPE1Q1pGTEx",
  },
  eventId: "evt_287590215710",
  eventType: "PAYMENT_SUCCESS",
  timestamp: "2026-05-14T07:40:18.844069331Z",
  apiVersion: "2026-01-01",
};

describe("FilixPay notification handling", () => {
  it("parses payment success notifications", () => {
    expect(parseFilixPayNotification(JSON.stringify(payload))).toEqual(payload);
  });

  it("verifies the HMAC SHA-256 signature against the raw body", () => {
    const rawBody = JSON.stringify(payload);
    const secret = "webhook-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

    expect(verifyFilixPaySignature(rawBody, signature, secret)).toBe(true);
    expect(verifyFilixPaySignature(`${rawBody}\n`, signature, secret)).toBe(false);
  });

  it("maps payment success notifications to Saleor charge success", () => {
    expect(mapFilixPayEventToSaleorEvent(payload)).toBe("CHARGE_SUCCESS");
  });

  it("extracts the Saleor transaction token from the FilixPay merchant order ID", () => {
    expect(
      getTransactionTokenFromMerchantOrderId("SALEOR-2504a1ab-7fcb-41a0-8007-a403efc7826d")
    ).toBe("2504a1ab-7fcb-41a0-8007-a403efc7826d");
    expect(getTransactionTokenFromMerchantOrderId("2026051403946329234091762737")).toBeNull();
  });
});

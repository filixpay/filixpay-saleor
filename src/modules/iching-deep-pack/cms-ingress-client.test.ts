import { afterEach, describe, expect, it, vi } from "vitest";
import { postIchingEntitlementConfirmed } from "./cms-ingress-client";

const target = {
  eventId: "TN1:T3JkZXJMaW5lOjk5OQ==",
  sourceOrderId: "T3JkZXI6OTk5",
  sourceOrderLineId: "T3JkZXJMaW5lOjk5OQ==",
  sku: "ICHING-DEEP-199" as const,
  readingId: "782479dd-4dcb-4d41-bd2b-6e1407b6a399",
  purchaserUserId: "VXNlcjo5OTk=",
};

describe("postIchingEntitlementConfirmed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("POSTs CONFIRMED body and returns fulfilled kind", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ kind: "fulfilled" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await postIchingEntitlementConfirmed({
      cmsBaseUrl: "https://cms.example.com",
      secret: "test-ingress-secret",
      target,
    });

    expect(result).toEqual({ ok: true, kind: "fulfilled" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cms.example.com/api/iching/entitlement/ingress/confirmed",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "x-iching-entitlement-secret": "test-ingress-secret",
        }),
      })
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      eventId: target.eventId,
      filixPaymentState: "CONFIRMED",
      sourceOrderId: target.sourceOrderId,
      sourceOrderLineId: target.sourceOrderLineId,
      sku: "ICHING-DEEP-199",
      readingId: target.readingId,
      purchaserUserId: target.purchaserUserId,
    });
  });

  it("maps DEEP_PACK_ALREADY_OWNED as failed outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 403,
        json: async () => ({
          error: { code: "DEEP_PACK_ALREADY_OWNED", message: "owned" },
        }),
      })
    );

    await expect(
      postIchingEntitlementConfirmed({
        cmsBaseUrl: "https://cms.example.com",
        secret: "secret",
        target,
      })
    ).resolves.toEqual({
      ok: false,
      status: 403,
      code: "DEEP_PACK_ALREADY_OWNED",
      message: "owned",
    });
  });

  it("treats already_fulfilled and replayed as success", async () => {
    for (const kind of ["already_fulfilled", "replayed"] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          status: 200,
          json: async () => ({ kind }),
        })
      );
      await expect(
        postIchingEntitlementConfirmed({
          cmsBaseUrl: "https://cms.example.com",
          secret: "secret",
          target,
        })
      ).resolves.toEqual({ ok: true, kind });
    }
  });
});

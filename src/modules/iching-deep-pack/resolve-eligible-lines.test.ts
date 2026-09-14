import { describe, expect, it } from "vitest";
import {
  buildDeepPackEventId,
  resolveEligibleDeepPackLines,
} from "./resolve-eligible-lines";

const orderBase = {
  id: "T3JkZXI6OTk5",
  user: { id: "VXNlcjo5OTk=" },
};

describe("resolveEligibleDeepPackLines", () => {
  it("builds eventId as tradeNo:OrderLine.id", () => {
    expect(buildDeepPackEventId("2026091400657261187851773672", "T3JkZXJMaW5lOjk5OQ==")).toBe(
      "2026091400657261187851773672:T3JkZXJMaW5lOjk5OQ=="
    );
  });

  it("selects line by variant sku and readingId", () => {
    const targets = resolveEligibleDeepPackLines(
      {
        ...orderBase,
        lines: [
          {
            id: "T3JkZXJMaW5lOjk5OQ==",
            metadata: [{ key: "readingId", value: "782479dd-4dcb-4d41-bd2b-6e1407b6a399" }],
            variant: { sku: "ICHING-DEEP-199" },
          },
        ],
      },
      "2026091400657261187851773672"
    );

    expect(targets).toEqual([
      {
        eventId: "2026091400657261187851773672:T3JkZXJMaW5lOjk5OQ==",
        sourceOrderId: "T3JkZXI6OTk5",
        sourceOrderLineId: "T3JkZXJMaW5lOjk5OQ==",
        sku: "ICHING-DEEP-199",
        readingId: "782479dd-4dcb-4d41-bd2b-6e1407b6a399",
        purchaserUserId: "VXNlcjo5OTk=",
      },
    ]);
  });

  it("selects line by metadata.ichingSku when variant sku differs", () => {
    const targets = resolveEligibleDeepPackLines(
      {
        ...orderBase,
        lines: [
          {
            id: "T3JkZXJMaW5lOjEwMDA=",
            metadata: [
              { key: "ichingSku", value: "ICHING-DEEP-199" },
              { key: "readingId", value: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
            ],
            variant: { sku: "OTHER-SKU" },
          },
        ],
      },
      "TN1"
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]?.sku).toBe("ICHING-DEEP-199");
  });

  it("skips Deep Pack sku lines missing readingId (no Order fallback)", () => {
    expect(
      resolveEligibleDeepPackLines(
        {
          ...orderBase,
          lines: [
            {
              id: "T3JkZXJMaW5lOjEwMDE=",
              metadata: [],
              variant: { sku: "ICHING-DEEP-199" },
            },
          ],
        },
        "TN1"
      )
    ).toEqual([]);
  });

  it("returns empty when Order.user is missing", () => {
    expect(
      resolveEligibleDeepPackLines(
        {
          id: "T3JkZXI6OTk5",
          user: null,
          lines: [
            {
              id: "T3JkZXJMaW5lOjk5OQ==",
              metadata: [{ key: "readingId", value: "782479dd-4dcb-4d41-bd2b-6e1407b6a399" }],
              variant: { sku: "ICHING-DEEP-199" },
            },
          ],
        },
        "TN1"
      )
    ).toEqual([]);
  });

  it("never uses a checkoutLineId-shaped field (OrderLine.id only)", () => {
    const targets = resolveEligibleDeepPackLines(
      {
        ...orderBase,
        lines: [
          {
            id: "T3JkZXJMaW5lOjk5OQ==",
            metadata: [{ key: "readingId", value: "782479dd-4dcb-4d41-bd2b-6e1407b6a399" }],
            variant: { sku: "ICHING-DEEP-199" },
          },
        ],
      },
      "TN1"
    );
    expect(targets[0]?.sourceOrderLineId).toBe("T3JkZXJMaW5lOjk5OQ==");
    expect(targets[0]?.eventId.endsWith(":T3JkZXJMaW5lOjk5OQ==")).toBe(true);
  });
});

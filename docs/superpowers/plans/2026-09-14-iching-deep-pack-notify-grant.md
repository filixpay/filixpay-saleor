# I Ching Deep Pack Notify Grant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After FilixPay `PAYMENT_SUCCESS` settlement via `transactionEventReport`, conditionally POST micselect-cms Deep Pack entitlement ingress using Saleor OrderLine identity — without blocking Notify HTTP 200 or failing Saleor settlement when grant fails.

**Architecture:** Modular `src/modules/iching-deep-pack/` (resolve lines → short-window wait for Order → CMS client → orchestrate). `filixpay-notify` fires orchestration with `void …catch` **before** returning 200. Ops replay reuses the same grant path once Order exists. FilixPay core and storefront stay unchanged.

**Tech Stack:** Next.js API routes, Saleor GraphQL (urql + codegen), Vitest, `fetch` for CMS.

**Spec:** `docs/superpowers/specs/2026-09-14-iching-deep-pack-notify-grant-design.md` (Frozen)

## Global Constraints

- FilixPay payment core does not call CMS; grant orchestration lives only in this platform Notify consumer.
- `paymentEventId` = FilixPay `data.tradeNo` (never top-level notify `eventId`).
- `sourceOrderLineId` / `eventId` suffix = Saleor **OrderLine.id** only (never CheckoutLine.id).
- `readingId` = **OrderLine.metadata.readingId** only (no Order/Checkout metadata fallback).
- `purchaserUserId` = `Order.user.id` GraphQL global ID string as returned.
- `filixPaymentState` always `"CONFIRMED"` on this path.
- SKU gate: `variant.sku === "ICHING-DEEP-199"` OR `metadata.ichingSku === "ICHING-DEEP-199"`.
- Notify success = signature + find transaction + `transactionEventReport` success → **HTTP 200 before** Deep Pack short-window work.
- CMS / metadata patch / poll failures must not return 5xx on notify.
- `DEEP_PACK_ALREADY_OWNED` is a commercial exception (ERROR log), not a success ack.
- Do not invent real PII in tests (`example.com`, fake Saleor global ids).
- Agent may create/modify `*.test.ts` for this task (user-requested).
- Prefer fictional Saleor ids like `T3JkZXI6OTk5` / `T3JkZXJMaW5lOjk5OQ==` / `VXNlcjo5OTk=` in fixtures.

## File structure

| Path | Responsibility |
|------|----------------|
| `src/modules/iching-deep-pack/constants.ts` | SKU + metadata key constants |
| `src/modules/iching-deep-pack/types.ts` | Shared types / outcomes |
| `src/modules/iching-deep-pack/resolve-eligible-lines.ts` | Pure line → grant target mapping |
| `src/modules/iching-deep-pack/cms-ingress-client.ts` | POST CMS confirmed |
| `src/modules/iching-deep-pack/wait-for-order.ts` | Short-window poll |
| `src/modules/iching-deep-pack/orchestrate.ts` | End-to-end after charge success |
| `src/modules/iching-deep-pack/replay.ts` | Ops replay (single fetch, no short window) |
| `src/modules/iching-deep-pack/fetch-transaction-order.ts` | Map Saleor transaction query → OrderLike |
| `src/modules/iching-deep-pack/*.test.ts` | Unit tests colocated |
| `graphql/fragments/Transaction.graphql` | Add order lines/user + checkout.id |
| `src/pages/api/webhooks/filixpay-notify.ts` | Fire-and-forget after report |
| `src/pages/api/ops/iching-deep-pack-replay.ts` | Authenticated replay |
| `src/modules/filixpay/find-saleor-transaction.ts` | Extract shared finder from notify |
| `.env.example` | CMS + poll + replay env placeholders |
| `docs/integration-guide.md`, `docs/README.md` | Architecture wording |

---

### Task 1: Constants, types, resolve-eligible-lines

**Files:**
- Create: `src/modules/iching-deep-pack/constants.ts`
- Create: `src/modules/iching-deep-pack/types.ts`
- Create: `src/modules/iching-deep-pack/resolve-eligible-lines.ts`
- Create: `src/modules/iching-deep-pack/resolve-eligible-lines.test.ts`

**Interfaces:**
- Produces: `ICHING_DEEP_SKU`, `METADATA_READING_ID`, `METADATA_ICHING_SKU`, `OrderLineLike`, `DeepPackGrantTarget`, `resolveEligibleDeepPackLines(order, tradeNo)`, `buildDeepPackEventId(tradeNo, orderLineId)`, `findDeepPackLinesMissingReadingId(order)`

- [ ] **Step 1: Write the failing test**

Create `src/modules/iching-deep-pack/resolve-eligible-lines.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/modules/iching-deep-pack/resolve-eligible-lines.test.ts`

Expected: FAIL (module not found / export missing)

- [ ] **Step 3: Write minimal implementation**

`src/modules/iching-deep-pack/constants.ts`:

```ts
export const ICHING_DEEP_SKU = "ICHING-DEEP-199";
export const METADATA_READING_ID = "readingId";
export const METADATA_ICHING_SKU = "ichingSku";
```

`src/modules/iching-deep-pack/types.ts`:

```ts
export type MetadataItemLike = { key: string; value: string };

export type OrderLineLike = {
  id: string;
  metadata: MetadataItemLike[];
  variant?: { sku?: string | null } | null;
};

export type OrderLike = {
  id: string;
  user?: { id: string } | null;
  lines: OrderLineLike[];
};

export type DeepPackGrantTarget = {
  eventId: string;
  sourceOrderId: string;
  sourceOrderLineId: string;
  sku: "ICHING-DEEP-199";
  readingId: string;
  purchaserUserId: string;
};

export type CmsIngressSuccessKind = "fulfilled" | "already_fulfilled" | "replayed";

export type CmsIngressResult =
  | { ok: true; kind: CmsIngressSuccessKind }
  | { ok: false; status: number; code?: string; message?: string };
```

`src/modules/iching-deep-pack/resolve-eligible-lines.ts`:

```ts
import { ICHING_DEEP_SKU, METADATA_ICHING_SKU, METADATA_READING_ID } from "./constants";
import type { DeepPackGrantTarget, MetadataItemLike, OrderLike } from "./types";

function metaValue(metadata: MetadataItemLike[], key: string): string | undefined {
  const hit = metadata.find((item) => item.key === key);
  const value = hit?.value?.trim();
  return value ? value : undefined;
}

export function buildDeepPackEventId(tradeNo: string, orderLineId: string): string {
  return `${tradeNo}:${orderLineId}`;
}

function isDeepPackLine(line: OrderLike["lines"][number]): boolean {
  if (line.variant?.sku === ICHING_DEEP_SKU) {
    return true;
  }
  return metaValue(line.metadata, METADATA_ICHING_SKU) === ICHING_DEEP_SKU;
}

export function resolveEligibleDeepPackLines(
  order: OrderLike,
  tradeNo: string
): DeepPackGrantTarget[] {
  const purchaserUserId = order.user?.id?.trim();
  if (!purchaserUserId) {
    return [];
  }

  const targets: DeepPackGrantTarget[] = [];

  for (const line of order.lines) {
    if (!isDeepPackLine(line)) {
      continue;
    }
    const readingId = metaValue(line.metadata, METADATA_READING_ID);
    if (!readingId) {
      continue;
    }
    targets.push({
      eventId: buildDeepPackEventId(tradeNo, line.id),
      sourceOrderId: order.id,
      sourceOrderLineId: line.id,
      sku: ICHING_DEEP_SKU,
      readingId,
      purchaserUserId,
    });
  }

  return targets;
}

export function findDeepPackLinesMissingReadingId(order: OrderLike): OrderLike["lines"] {
  return order.lines.filter(
    (line) => isDeepPackLine(line) && !metaValue(line.metadata, METADATA_READING_ID)
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/modules/iching-deep-pack/resolve-eligible-lines.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/iching-deep-pack/constants.ts src/modules/iching-deep-pack/types.ts src/modules/iching-deep-pack/resolve-eligible-lines.ts src/modules/iching-deep-pack/resolve-eligible-lines.test.ts
git commit -m "$(cat <<'EOF'
feat(iching): add Deep Pack line eligibility resolver

Map Saleor OrderLines to CMS ingress targets using tradeNo:OrderLine.id only.
EOF
)"
```

---

### Task 2: CMS ingress client

**Files:**
- Create: `src/modules/iching-deep-pack/cms-ingress-client.ts`
- Create: `src/modules/iching-deep-pack/cms-ingress-client.test.ts`

**Interfaces:**
- Consumes: `DeepPackGrantTarget` from Task 1
- Produces: `postIchingEntitlementConfirmed(...)`, `getCmsIngressConfig()`

- [ ] **Step 1: Write the failing test**

Create `src/modules/iching-deep-pack/cms-ingress-client.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/modules/iching-deep-pack/cms-ingress-client.test.ts`

Expected: FAIL (module missing)

- [ ] **Step 3: Write minimal implementation**

`src/modules/iching-deep-pack/cms-ingress-client.ts`:

```ts
import type { CmsIngressResult, CmsIngressSuccessKind, DeepPackGrantTarget } from "./types";

export type CmsIngressConfig = {
  cmsBaseUrl: string;
  secret: string;
};

export function getCmsIngressConfig(
  env: NodeJS.ProcessEnv = process.env
): CmsIngressConfig | null {
  const cmsBaseUrl = env.MICSELECT_CMS_BASE_URL?.trim().replace(/\/$/, "");
  const secret = env.ICHING_ENTITLEMENT_INGRESS_SECRET?.trim();
  if (!cmsBaseUrl || !secret) {
    return null;
  }
  return { cmsBaseUrl, secret };
}

const SUCCESS_KINDS = new Set<CmsIngressSuccessKind>([
  "fulfilled",
  "already_fulfilled",
  "replayed",
]);

export async function postIchingEntitlementConfirmed(input: {
  cmsBaseUrl: string;
  secret: string;
  target: DeepPackGrantTarget;
  fetchImpl?: typeof fetch;
}): Promise<CmsIngressResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = `${input.cmsBaseUrl.replace(/\/$/, "")}/api/iching/entitlement/ingress/confirmed`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iching-entitlement-secret": input.secret,
    },
    body: JSON.stringify({
      eventId: input.target.eventId,
      filixPaymentState: "CONFIRMED",
      sourceOrderId: input.target.sourceOrderId,
      sourceOrderLineId: input.target.sourceOrderLineId,
      sku: input.target.sku,
      readingId: input.target.readingId,
      purchaserUserId: input.target.purchaserUserId,
    }),
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, status: response.status, message: "invalid JSON response" };
  }

  if (response.status === 200 && body && typeof body === "object" && "kind" in body) {
    const kind = (body as { kind: string }).kind;
    if (SUCCESS_KINDS.has(kind as CmsIngressSuccessKind)) {
      return { ok: true, kind: kind as CmsIngressSuccessKind };
    }
  }

  const error =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: { code?: string; message?: string } }).error
      : undefined;

  return {
    ok: false,
    status: response.status,
    code: error?.code,
    message: error?.message,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/modules/iching-deep-pack/cms-ingress-client.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/iching-deep-pack/cms-ingress-client.ts src/modules/iching-deep-pack/cms-ingress-client.test.ts
git commit -m "$(cat <<'EOF'
feat(iching): add CMS entitlement ingress client

POST confirmed with tradeNo-based eventId; map DEEP_PACK_ALREADY_OWNED as failure.
EOF
)"
```

---

### Task 3: wait-for-order short window

**Files:**
- Create: `src/modules/iching-deep-pack/wait-for-order.ts`
- Create: `src/modules/iching-deep-pack/wait-for-order.test.ts`

**Interfaces:**
- Produces: `waitForSaleorOrder(...)`, `getDeepPackPollConfig()`, `FetchOrderSnapshot`

- [ ] **Step 1: Write the failing test**

Create `src/modules/iching-deep-pack/wait-for-order.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/modules/iching-deep-pack/wait-for-order.test.ts`

Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

`src/modules/iching-deep-pack/wait-for-order.ts`:

```ts
import type { OrderLike } from "./types";

export type FetchOrderSnapshot = {
  order: OrderLike | null;
  checkoutId?: string | null;
};

export type DeepPackPollConfig = {
  attempts: number;
  baseDelayMs: number;
};

export function getDeepPackPollConfig(env: NodeJS.ProcessEnv = process.env): DeepPackPollConfig {
  const attempts = Number(env.ICHING_DEEP_PACK_POLL_ATTEMPTS ?? "5");
  const baseDelayMs = Number(env.ICHING_DEEP_PACK_POLL_BASE_MS ?? "2000");
  return {
    attempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 5,
    baseDelayMs: Number.isFinite(baseDelayMs) && baseDelayMs >= 0 ? Math.floor(baseDelayMs) : 2000,
  };
}

export async function waitForSaleorOrder(params: {
  fetchOrder: () => Promise<FetchOrderSnapshot>;
  sleep?: (ms: number) => Promise<void>;
  attempts: number;
  baseDelayMs: number;
}): Promise<FetchOrderSnapshot | null> {
  const sleep =
    params.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; attempt <= params.attempts; attempt += 1) {
    const snapshot = await params.fetchOrder();
    if (snapshot.order) {
      return snapshot;
    }
    if (attempt < params.attempts) {
      const delay = params.baseDelayMs * 2 ** (attempt - 1);
      await sleep(delay);
    }
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/modules/iching-deep-pack/wait-for-order.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/iching-deep-pack/wait-for-order.ts src/modules/iching-deep-pack/wait-for-order.test.ts
git commit -m "$(cat <<'EOF'
feat(iching): add short-window wait for Saleor Order

Exponential backoff poll with injectable fetch/sleep for Deep Pack grant.
EOF
)"
```

---

### Task 4: Extend Transaction GraphQL fragment + generate

**Files:**
- Modify: `graphql/fragments/Transaction.graphql`
- Regenerated: `generated/graphql.ts` (via codegen)

**Interfaces:**
- Produces: `TransactionFragment` includes `order.user`, `order.lines`, `checkout.id`

- [ ] **Step 1: Extend the fragment**

In `graphql/fragments/Transaction.graphql`, replace the existing `order { id number }` block and add `checkout`:

```graphql
  order {
    id
    number
    user {
      id
    }
    lines {
      id
      metadata {
        key
        value
      }
      variant {
        sku
      }
    }
  }
  checkout {
    id
  }
```

Keep all existing amount/events fields unchanged.

- [ ] **Step 2: Run codegen**

Run: `pnpm generate`

Expected: succeeds; `generated/graphql.ts` `TransactionFragment` includes new fields.

- [ ] **Step 3: Smoke typecheck**

Run: `pnpm exec tsc --noEmit`

Expected: no new errors from fragment change (ignore pre-existing if any).

- [ ] **Step 4: Commit**

```bash
git add graphql/fragments/Transaction.graphql generated/graphql.ts
git commit -m "$(cat <<'EOF'
feat(saleor): extend Transaction fragment for Deep Pack grant

Include order lines/user and checkout id for notify-side CMS orchestration.
EOF
)"
```

---

### Task 5: Orchestrator

**Files:**
- Create: `src/modules/iching-deep-pack/orchestrate.ts`
- Create: `src/modules/iching-deep-pack/orchestrate.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3
- Produces: `tryDeepPackGrantAfterChargeSuccess(...)`, `grantDeepPackForOrder(...)`

- [ ] **Step 1: Write the failing test**

Create `src/modules/iching-deep-pack/orchestrate.test.ts` with cases:

1. CMS config missing → skip, no `fetchOrder`
2. Order never appears → WARN with `paymentEventId`/`checkoutId`, no POST
3. Eligible OrderLine → one POST + INFO
4. `DEEP_PACK_ALREADY_OWNED` → ERROR containing that code, no throw

Use injectable `getConfig`, `fetchOrder`, `postConfirmed`, `sleep`, `poll` (see design §3). Fixture ids: `T3JkZXI6OTk5`, `T3JkZXJMaW5lOjk5OQ==`, `VXNlcjo5OTk=`, reading `782479dd-4dcb-4d41-bd2b-6e1407b6a399`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/modules/iching-deep-pack/orchestrate.test.ts`

Expected: FAIL

- [ ] **Step 3: Write orchestrator**

Implement `src/modules/iching-deep-pack/orchestrate.ts`:

- `grantDeepPackForOrder`: WARN missing purchaser / missing readingId lines; `resolveEligibleDeepPackLines`; POST each; INFO on success kinds; ERROR on failure including commercial `DEEP_PACK_ALREADY_OWNED`.
- `tryDeepPackGrantAfterChargeSuccess`: `getCmsIngressConfig` → skip if null; `waitForSaleorOrder`; WARN `order_not_ready` if null; else `grantDeepPackForOrder`.
- Structured log fields per spec §2.6 (`paymentEventId` = tradeNo, etc.).

Exact code may follow the draft in the design conversation; keep signatures:

```ts
export async function grantDeepPackForOrder(params: {
  order: OrderLike;
  tradeNo: string;
  merchantOrderId: string;
  checkoutId?: string | null;
  cmsBaseUrl: string;
  secret: string;
  logger: LoggerLike;
  postConfirmed?: typeof postIchingEntitlementConfirmed;
}): Promise<Array<{ target: DeepPackGrantTarget; result: CmsIngressResult }>>;

export async function tryDeepPackGrantAfterChargeSuccess(params: {
  tradeNo: string;
  merchantOrderId: string;
  logger: LoggerLike;
  fetchOrder: () => Promise<FetchOrderSnapshot>;
  getConfig?: typeof getCmsIngressConfig;
  postConfirmed?: typeof postIchingEntitlementConfirmed;
  sleep?: (ms: number) => Promise<void>;
  poll?: { attempts: number; baseDelayMs: number };
}): Promise<void>;
```

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run src/modules/iching-deep-pack/orchestrate.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/iching-deep-pack/orchestrate.ts src/modules/iching-deep-pack/orchestrate.test.ts
git commit -m "$(cat <<'EOF'
feat(iching): orchestrate Deep Pack grant after charge success

Short-window Order wait, fail-closed WARN, CMS POST with isolated errors.
EOF
)"
```

---

### Task 6: Wire Saleor fetch + filixpay-notify (200 first)

**Files:**
- Create: `src/modules/iching-deep-pack/fetch-transaction-order.ts`
- Modify: `src/pages/api/webhooks/filixpay-notify.ts`

**Interfaces:**
- Consumes: `TransactionDetailsViaIdDocument`, `tryDeepPackGrantAfterChargeSuccess`
- Produces: notify returns 200 without awaiting Deep Pack poll

- [ ] **Step 1: Add Saleor fetch helper**

`src/modules/iching-deep-pack/fetch-transaction-order.ts`:

```ts
import { AuthData } from "@saleor/app-sdk/APL";
import { createClient } from "@/lib/create-graphql-client";
import { TransactionDetailsViaIdDocument } from "@/generated/graphql";
import type { OrderLike } from "./types";
import type { FetchOrderSnapshot } from "./wait-for-order";

export function createFetchTransactionOrderSnapshot(
  authData: AuthData,
  transactionId: string
): () => Promise<FetchOrderSnapshot> {
  return async () => {
    const client = createClient(authData.saleorApiUrl, async () =>
      Promise.resolve({ token: authData.token })
    );
    const result = await client.query(TransactionDetailsViaIdDocument, {
      id: transactionId,
    });
    if (result.error) {
      throw result.error;
    }
    const transaction = result.data?.transaction;
    const order = transaction?.order;
    return {
      order: order
        ? ({
            id: order.id,
            user: order.user ? { id: order.user.id } : null,
            lines: (order.lines ?? []).map((line) => ({
              id: line.id,
              metadata: (line.metadata ?? []).map((m) => ({ key: m.key, value: m.value })),
              variant: line.variant ? { sku: line.variant.sku } : null,
            })),
          } satisfies OrderLike)
        : null,
      checkoutId: transaction?.checkout?.id ?? null,
    };
  };
}
```

- [ ] **Step 2: Wire notify handler (200 first)**

In `src/pages/api/webhooks/filixpay-notify.ts`, after successful `reportSaleorTransactionEvent`, **before** `return res.status(200)`:

```ts
if (eventType === TransactionEventTypeEnum.ChargeSuccess) {
  void patchFilixPayOrderSaleorMetadata(saleorTransaction.transaction, logger).catch((err) => {
    logger.error("Failed to patch FilixPay saleor-metadata (non-fatal)", {
      errorName: err instanceof Error ? err.name : undefined,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  });

  void tryDeepPackGrantAfterChargeSuccess({
    tradeNo: notification.data.tradeNo,
    merchantOrderId: notification.data.merchantOrderId,
    logger,
    fetchOrder: createFetchTransactionOrderSnapshot(
      saleorTransaction.authData,
      saleorTransaction.transaction.id
    ),
  }).catch((err) => {
    logger.error("Deep Pack orchestration unexpected error (non-fatal)", {
      paymentEventId: notification.data.tradeNo,
      merchantOrderId: notification.data.merchantOrderId,
      errorName: err instanceof Error ? err.name : undefined,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  });
}

logger.info("Processed FilixPay notification", { /* existing */ });
return res.status(200).json({ success: true });
```

**Critical:** Do **not** `await tryDeepPackGrantAfterChargeSuccess` before 200. Convert any blocking `await patchFilixPay…` on this path to `void`.

- [ ] **Step 3: Run Deep Pack unit tests**

Run: `pnpm exec vitest run src/modules/iching-deep-pack`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/modules/iching-deep-pack/fetch-transaction-order.ts src/pages/api/webhooks/filixpay-notify.ts
git commit -m "$(cat <<'EOF'
feat(notify): fire-and-forget Deep Pack grant after Saleor settlement

Return 200 before short-window poll; isolate CMS failures from FilixPay notify.
EOF
)"
```

---

### Task 7: Extract transaction finder + ops replay API

**Files:**
- Create: `src/modules/filixpay/find-saleor-transaction.ts`
- Modify: `src/pages/api/webhooks/filixpay-notify.ts`
- Create: `src/modules/iching-deep-pack/replay.ts`
- Create: `src/modules/iching-deep-pack/replay.test.ts`
- Create: `src/pages/api/ops/iching-deep-pack-replay.ts`

**Interfaces:**
- Produces: shared `findSaleorTransaction`, `runDeepPackReplay`, `POST /api/ops/iching-deep-pack-replay`

- [ ] **Step 1: Extract finder**

Move `findSaleorTransaction` + `transactionMatchesReference` from notify into `src/modules/filixpay/find-saleor-transaction.ts`; update notify imports. Behavior unchanged.

- [ ] **Step 2: Write replay tests**

`replay.test.ts`:

- Order missing → `{ status: "order_not_ready" }`, no POST
- Order eligible → `{ status: "ok" }`, POST called

- [ ] **Step 3: Implement `runDeepPackReplay` + API route**

`runDeepPackReplay`: no short window; single `fetchOrder`; then `grantDeepPackForOrder`.

`src/pages/api/ops/iching-deep-pack-replay.ts`:

- POST only
- Auth: `x-iching-deep-pack-replay-secret` or `Authorization: Bearer` equals `ICHING_DEEP_PACK_REPLAY_SECRET || ICHING_ENTITLEMENT_INGRESS_SECRET`
- Body: `{ tradeNo, merchantOrderId }` (zod)
- `findSaleorTransaction([tradeNo, merchantOrderId])` → 404 if missing
- Map: `cms_not_configured`→503, `order_not_ready`→409, `ok`→200 with per-line outcomes

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run src/modules/iching-deep-pack`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/filixpay/find-saleor-transaction.ts src/pages/api/webhooks/filixpay-notify.ts src/modules/iching-deep-pack/replay.ts src/modules/iching-deep-pack/replay.test.ts src/pages/api/ops/iching-deep-pack-replay.ts
git commit -m "$(cat <<'EOF'
feat(ops): add Deep Pack grant replay endpoint

Reuse OrderLine grant path for paid orders that missed the notify short window.
EOF
)"
```

---

### Task 8: Env + docs

**Files:**
- Modify: `.env.example`
- Modify: `docs/integration-guide.md`
- Modify: `docs/README.md`

- [ ] **Step 1: Update `.env.example`**

Append placeholders (commented):

```env
# --- Optional: micselect CMS Deep Pack grant (platform Notify consumer) ---
# MICSELECT_CMS_BASE_URL=https://cms.your-domain.com
# ICHING_ENTITLEMENT_INGRESS_SECRET=shared-with-cms-ingress
# ICHING_DEEP_PACK_REPLAY_SECRET=prefer-dedicated-ops-secret
# ICHING_DEEP_PACK_POLL_ATTEMPTS=5
# ICHING_DEEP_PACK_POLL_BASE_MS=2000
```

- [ ] **Step 2: Update integration guide**

- Role table: Payment App = Saleor settlement + **(conditional)** CMS Deep Pack grant orchestration
- Callout: **FilixPay = payment + Notify delivery; Payment App = Saleor settlement + (conditional) CMS Deep Pack grant orchestration.**
- E2E: 200 to FilixPay before best-effort short-window → CMS ingress; ops replay if miss
- Document `POST /api/ops/iching-deep-pack-replay`
- Link frozen spec

- [ ] **Step 3: Update `docs/README.md`** with spec + plan links

- [ ] **Step 4: Commit**

```bash
git add .env.example docs/integration-guide.md docs/README.md
git commit -m "$(cat <<'EOF'
docs: document Deep Pack Notify grant boundary and ops replay

Clarify FilixPay vs Payment App responsibilities and CMS env vars.
EOF
)"
```

---

### Task 9: Full test run + ops checklist for incident

**Files:** none (verification)

- [ ] **Step 1: Run related unit tests**

Run: `pnpm exec vitest run src/modules/iching-deep-pack src/modules/filixpay/notify.test.ts src/modules/filixpay/saleor-metadata-patch.test.ts`

Expected: all PASS

- [ ] **Step 2: Ops replay checklist (incident)**

For `SALEOR-0fc92175-…` / reading `782479dd-…` (after deploy + env):

1. Confirm Saleor Order exists; OrderLine has `readingId` + Deep Pack SKU/`ichingSku`.
2. Confirm `Order.user.id` matches CMS Reading USER owner.
3. `POST /api/ops/iching-deep-pack-replay` with `{ tradeNo, merchantOrderId: "SALEOR-0fc92175-..." }` + replay secret.
4. Expect CMS success kind; Reading `hasEffectiveDeepPack=true`.
5. 409 `order_not_ready` → complete checkout, retry.
6. `DEEP_PACK_ALREADY_OWNED` → commercial exception (CMS H12), not success.

- [ ] **Step 3: Stop** (no empty commit)

---

## Spec coverage self-check

| Spec requirement | Task |
|------------------|------|
| Boundaries / docs wording | 8 |
| 200 before short window | 6 |
| tradeNo paymentEventId | 1, 2, 5 |
| OrderLine only / no CheckoutLine | 1, 5, 7 |
| OrderLine.metadata.readingId only | 1, 5 |
| purchaserUserId = Order.user.id global id | 1, 5 |
| CONFIRMED mapping | 2 |
| Short window A + structured WARN | 3, 5 |
| CMS client + DEEP_PACK_ALREADY_OWNED | 2, 5 |
| Notify isolation | 6 |
| Ops replay | 7, 9 |
| Env | 8 |
| Tests | 1–3, 5, 7, 9 |
| GraphQL lines | 4 |

## Placeholder / consistency scan

- No TBD steps; names aligned: `tryDeepPackGrantAfterChargeSuccess`, `grantDeepPackForOrder`, `runDeepPackReplay`, `postIchingEntitlementConfirmed`.
- `eventId` always `${tradeNo}:${OrderLine.id}`.
- Revised spec “200 first” reflected in Task 6 (not await poll before response).

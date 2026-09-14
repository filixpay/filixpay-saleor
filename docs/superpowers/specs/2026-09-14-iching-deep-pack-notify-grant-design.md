# I Ching Deep Pack — Notify Consumer Grant Orchestration (V1)

**Date:** 2026-09-14  
**Status:** Frozen  
**Repo:** `filixpay-saleor` (platform Notify consumer at `pay.micselect.com`)  
**Related CMS spec:** `micselect-cms` → `docs/superpowers/specs/2026-09-13-i-ching-deep-pack-checkout-handoff-v1-design.md` (§8.3 / §9.2 / §10)  
**Review:** 2026-09-14 — fixed notify HTTP vs short-window ordering; strengthened purchaser/metadata/CMS error notes.

---

## 1. Boundaries and responsibilities

```text
FilixPay payment core     = capture payment + deliver terminal state to Notify URL
                            (no CMS, no divination, no grant)
filixpay-saleor Notify    = Saleor settlement (transactionEventReport)
                            + (conditional) platform Deep Pack grant orchestration
micselect-cms ingress     = sole authority for grant semantics
Storefront                = checkoutComplete; does not call ingress
```

| Actor | Does | Does not |
|-------|------|----------|
| FilixPay | Pay + notify | Call CMS / grant |
| This Payment App (`/api/webhooks/filixpay-notify`) | Saleor `transactionEventReport`; conditional CMS `ingress/confirmed` | Re-implement grant rules |
| micselect-cms | Grant Deep Pack entitlements | Depend on FilixPay calling it directly |
| Storefront | Complete checkout after charge | Call entitlement ingress |

### Footnotes (frozen)

1. **Conditional POST only when all hold:** Saleor `Order` + `OrderLine` exist; SKU is `ICHING-DEEP-199` (variant SKU **or** line `metadata.ichingSku`); **`OrderLine.metadata.readingId` present** (no fallback to Order- or Checkout-only metadata in V1); `purchaserUserId` resolvable from `Order.user.id`. Otherwise structured WARN and **no** CMS POST.
2. **Notify success definition:** HTTP **200 after** verify signature + find transaction + successful `transactionEventReport`. CMS grant, FilixPay saleor-metadata patch, and short-window wait for Order are **best-effort** — failures must **not** return 5xx (avoids FilixPay redelivery storms that scramble settlement).
3. **HTTP 200 before Deep Pack short-window (frozen):** Settlement completes → respond **200 first** (or equivalent: do not block the Notify response on the 12–15s poll). Deep Pack runs **after** settlement success as fire-and-forget / post-response work so FilixPay client timeouts do not redeliver a already-settled payment. See §2.1 and §3.5.
4. **`PAYMENT_SUCCESS` → ingress `filixPaymentState: "CONFIRMED"`:** On this Notify path, a terminal FilixPay `PAYMENT_SUCCESS` (reported to Saleor as `CHARGE_SUCCESS`) is mapped to CMS handoff vocabulary `filixPaymentState: "CONFIRMED"`. FilixPay core still does not call CMS; the Payment App performs the mapping when POSTing ingress.

### Non-goals

- Do not change FilixPay payment core to call CMS.
- Do not change storefront to call ingress.
- Do not put grant into arbitrary merchant Notify consumers — only this platform Saleor commerce Notify consumer.
- Do not use CheckoutLine.id as `eventId` suffix or grant idempotency key.
- Do not ship a durable outbox/worker in V1.
- Do not treat missing OrderLine `readingId` as recoverable via Order/Checkout metadata fallback in V1 (forces checkout→order metadata propagation).

---

## 2. Data flow, short window, failure isolation

### 2.1 Happy path

```text
FilixPay PAYMENT_SUCCESS
  → POST /api/webhooks/filixpay-notify (HMAC)
  → parse; paymentEventId := data.tradeNo
  → find Saleor transaction (merchantOrderId SALEOR-{token} / psp)
  → transactionEventReport(CHARGE_SUCCESS)     ✅ required for notify success
  → best-effort start (must not throw into outer catch):
       patch FilixPay saleor-metadata (existing)
       schedule / void Deep Pack orchestration (new)   // does NOT block 200
  → 200 { success: true }                      ✅ settlement complete for FilixPay

  // After 200 (same Node process if platform allows; else fire-and-forget before end):
  → Deep Pack short-window poll until Order (+ lines) appear
  → if eligible OrderLine(s) → POST CMS ingress/confirmed
```

**Ordering rule (frozen):** `transactionEventReport` success ⇒ Notify HTTP **200** is owed for settlement. Short-window poll (≤ ~12–15s) **must not** delay that 200. Prefer:

1. `void tryDeepPackGrantAfterChargeSuccess(...).catch(log)` then `return 200`, or  
2. `res.status(200).json(...)` then continue orchestration if the runtime guarantees continued execution (document platform limits; if serverless freezes after response, use (1) with a tight in-process budget only when empirically safe).

Typical timing: shopper return → `checkoutComplete` often lands within seconds after charge report. V1 relies on that + ops replay, not a queue.

### 2.2 Stable identity rules (CMS handoff aligned)

| Field | Value |
|-------|--------|
| `paymentEventId` | FilixPay `data.tradeNo` (stable payment fact; **not** top-level notify `eventId`) |
| `sourceOrderLineId` | Saleor **OrderLine.id** only (never CheckoutLine.id) |
| `readingId` | **`OrderLine.metadata.readingId` only** (must survive checkout → order; else fail-closed — no Order/Checkout metadata fallback in V1) |
| `eventId` | `{tradeNo}:{OrderLine.id}` |
| `filixPaymentState` | Always `CONFIRMED` on this path (§1 footnote 4) |
| `sku` | `ICHING-DEEP-199` |
| `purchaserUserId` | Saleor `Order.user.id` **global ID string as returned by GraphQL** (same form Claim / CMS Reading `USER` owner uses — typically `VXNlcjox…` / `User:…` base64 global id). Raw numeric DB ids must not be invented. Must match Reading USER owner SSOT or CMS returns `OWNER_MISMATCH`. |

CMS grant idempotency (owned by CMS, not reimplemented here): `grant:{sourceOrderLineId}:{sku}`.

### 2.3 Short-window poll (Approach A)

After successful `transactionEventReport` for `CHARGE_SUCCESS`, **scheduled without blocking Notify 200**:

1. If `MICSELECT_CMS_BASE_URL` or `ICHING_ENTITLEMENT_INGRESS_SECRET` missing → skip Deep Pack (debug log).
2. Poll Saleor for `transaction.order` with lines (and `checkout.id` for logs only).
3. Defaults (tunable via env):
   - Max attempts: **5**
   - Backoff: **2s → 4s → …**
   - Total wait budget: **≤ ~12–15s** (runs after / off the critical Notify response path; tighten after measuring FilixPay client timeout if any in-request work remains)
4. If Order still missing when budget exhausted → **do not POST CMS**; WARN with structured replay fields.
5. When Order exists → evaluate lines and POST (see §2.4).

**Never** substitute CheckoutLine.id when Order is missing.

### 2.4 Line eligibility and CMS call

**V1 line set:** Process OrderLine(s) on the resolved Order whose SKU matches Deep Pack and that are attributable to this payment. Deep Pack checkout is single-line today; if multiple `ICHING-DEEP-199` lines appear, POST **one ingress per line** (distinct `eventId`). Do not invent multi-payment allocation logic beyond “this Order was settled by this `tradeNo` / SALEOR transaction.”

For each OrderLine:

| Condition | Action |
|-----------|--------|
| `variant.sku === "ICHING-DEEP-199"` **or** `metadata.ichingSku === "ICHING-DEEP-199"` | Candidate |
| Missing `OrderLine.metadata.readingId` | Fail-closed WARN for that line; no POST (no Order/Checkout fallback) |
| Missing `Order.user.id` | Fail-closed WARN; no POST |
| Eligible | POST ingress (§3.3) |

CMS success kinds (HTTP 200): `fulfilled` | `already_fulfilled` | `replayed` → INFO ack.  
CMS errors → ERROR structured log; still do not fail notify HTTP:

| CMS code | Ops meaning |
|----------|-------------|
| `UNAUTHORIZED` / `INVALID_BODY` / `READING_ID_REQUIRED` / … | Fix config/payload; replay |
| **`DEEP_PACK_ALREADY_OWNED` (403)** | **Commercial exception** (new OrderLine vs Reading that already has an effective Pack) — **not** a success ack; DLQ/ops/refund path per CMS H12; do not treat as “grant OK” |

### 2.5 Failure isolation matrix

| Failure | Notify HTTP | FilixPay should redeliver for this? |
|---------|-------------|-------------------------------------|
| Bad signature / missing webhook secret | 401/500 | N/A / ops |
| Saleor transaction not found | 404 | Maybe (settlement incomplete) |
| `transactionEventReport` fails | 500 | Yes (settlement) |
| Short window: no Order yet | **200** | **No** (use ops replay) |
| Missing readingId / purchaserUserId | **200** | **No** |
| CMS network / 4xx / 5xx / `DEEP_PACK_ALREADY_OWNED` | **200** | **No** (ops replay / commercial exception) |
| FilixPay saleor-metadata patch fails | **200** | **No** |

### 2.6 Structured log / “light DLQ” fields

Minimum fields on WARN/ERROR for ops replay:

```text
paymentEventId (= tradeNo)
merchantOrderId
transactionToken
checkoutId?
saleorOrderId?
orderLineId?
readingId?
sku?
reason
```

V1 “DLQ” = these structured logs + authenticated replay API (§3.4). No durable queue.

---

## 3. Module split, GraphQL, CMS client, ops replay

### 3.1 Recommended layout (Approach 1 — modular orchestration)

```text
src/modules/iching-deep-pack/
  constants.ts              # SKU ICHING-DEEP-199, metadata keys
  types.ts                  # GrantAttemptInput, CmsIngressBody, outcomes
  resolve-eligible-lines.ts # Pure: Order lines → eligible grant targets
  wait-for-order.ts         # Short-window poll helper (injectable sleep + fetchOrder)
  cms-ingress-client.ts     # POST confirmed + parse kind/error
  orchestrate.ts            # tryDeepPackGrantAfterChargeSuccess(...)
  replay.ts                 # Same core path given tradeNo + Saleor auth context

src/pages/api/webhooks/filixpay-notify.ts
  # After successful CHARGE_SUCCESS report:
  #   void tryDeepPack...(…).catch(log)  THEN return 200
  # Must not await short-window in a way that delays 200 or throws into outer catch → 500

src/pages/api/ops/iching-deep-pack-replay.ts
  # Authenticated ops replay (same secret or dedicated OPS secret)

graphql/fragments/Transaction.graphql  (extend)
  # order { id number user { id } lines { id metadata { key value }
  #         variant { sku } } }
  # checkout { id }   # log only

.env.example
  # MICSELECT_CMS_BASE_URL=
  # ICHING_ENTITLEMENT_INGRESS_SECRET=
  # optional: ICHING_DEEP_PACK_POLL_* / ICHING_DEEP_PACK_REPLAY_SECRET
```

Docs updates:

- `docs/integration-guide.md` — role table + flow: FilixPay = pay+notify; Payment App = Saleor + conditional CMS grant.
- `docs/README.md` — link this spec.
- This file under `docs/superpowers/specs/`.

### 3.2 Saleor GraphQL

Extend transaction query fragment used by notify:

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

Eligibility helpers (pure, unit-tested):

- Deep SKU match: `variant?.sku === "ICHING-DEEP-199"` OR metadata key `ichingSku` === `ICHING-DEEP-199`.
- `readingId` from **line** metadata key `readingId` only.
- Build `eventId = `${tradeNo}:${orderLine.id}``.
- `purchaserUserId` = `order.user.id` as returned (global ID string).

### 3.3 CMS ingress HTTP (V1 contract)

```http
POST {MICSELECT_CMS_BASE_URL}/api/iching/entitlement/ingress/confirmed
Content-Type: application/json
x-iching-entitlement-secret: <ICHING_ENTITLEMENT_INGRESS_SECRET>
```

(`Authorization: Bearer <same secret>` also accepted by CMS; client may send header form.)

Body:

```json
{
  "eventId": "{tradeNo}:{OrderLine.id}",
  "filixPaymentState": "CONFIRMED",
  "sourceOrderId": "<Order.id>",
  "sourceOrderLineId": "<OrderLine.id>",
  "sku": "ICHING-DEEP-199",
  "readingId": "<uuid>",
  "purchaserUserId": "<Order.user.id global id>"
}
```

Success (200): `{ "kind": "fulfilled" | "already_fulfilled" | "replayed" }`.  
Failure: `{ "error": { "code": "...", "message": "..." } }` — log; do not fail notify. Treat `DEEP_PACK_ALREADY_OWNED` as commercial exception (§2.4).

### 3.4 Ops replay (A’s required companion)

**Endpoint (V1):** `POST /api/ops/iching-deep-pack-replay`

Auth: `ICHING_DEEP_PACK_REPLAY_SECRET` if set, else same `ICHING_ENTITLEMENT_INGRESS_SECRET` (document clearly; prefer dedicated secret in prod).

Request body (minimal):

```json
{
  "tradeNo": "2026091400657261187851773672",
  "merchantOrderId": "SALEOR-0fc92175-..."
}
```

Behavior:

1. Resolve Saleor transaction via existing finder (`SALEOR-{token}` / psp).
2. **No** short window required if Order already exists; if still no Order → 409 with structured reason.
3. Run same `orchestrate` / CMS POST path (idempotent via CMS `eventId`).
4. Return per-line outcomes for ops.

**Incident replay target:** `SALEOR-0fc92175-…` / reading `782479dd-…` — after Order exists, replay with that payment’s `tradeNo` so `eventId` matches future notify retries.

### 3.5 Notify handler integration sketch

```ts
// After successful transactionEventReport for CHARGE_SUCCESS:

// Non-fatal existing path
void patchFilixPayOrderSaleorMetadata(transaction, logger).catch((err) =>
  logger.warn("saleor-metadata patch failed (non-fatal)", { err }),
);

// Deep Pack: must NOT delay Notify 200 on short-window poll
void tryDeepPackGrantAfterChargeSuccess({
  authData,
  transactionId: transaction.id,
  tradeNo: notification.data.tradeNo,
  merchantOrderId: notification.data.merchantOrderId,
  logger,
}).catch((err) =>
  logger.error("Deep Pack orchestration unexpected error (non-fatal)", { err }),
);

return res.status(200).json({ success: true });
```

Outer `catch` of the handler remains only for signature / find / report failures.

### 3.6 Configuration

| Env | Required for Deep Pack | Notes |
|-----|------------------------|-------|
| `MICSELECT_CMS_BASE_URL` | Yes | No trailing slash; public/Payload origin |
| `ICHING_ENTITLEMENT_INGRESS_SECRET` | Yes | Shared with CMS |
| `ICHING_DEEP_PACK_REPLAY_SECRET` | Optional | Ops replay; fallback to ingress secret |
| `ICHING_DEEP_PACK_POLL_ATTEMPTS` | Optional | Default 5 |
| `ICHING_DEEP_PACK_POLL_BASE_MS` | Optional | Default 2000 |

If CMS env incomplete, Payment App still settles Saleor; Deep Pack skipped.

### 3.7 Testing (implementation plan will detail)

Per `AGENTS.md`, agents do not invent tests unless the task asks — **this task asks**. Cover:

- Pure: SKU / `ichingSku` / missing readingId / eventId composition (never CheckoutLine); no Order-metadata fallback.
- Client: maps 200 kinds; treats error codes (incl. `DEEP_PACK_ALREADY_OWNED`) as non-throwing outcomes for orchestrator.
- Orchestrator: no Order after poll → no CMS call + WARN fields; eligible line → one POST; CMS throw → swallowed at notify boundary.
- Notify boundary: settlement success returns 200 even if Deep Pack promise rejects.
- Replay: Order present → POST; Order absent → 409.

Ops checklist for `SALEOR-0fc92175-…` / `782479dd-…`: confirm **OrderLine** metadata has `readingId`; call replay; CMS reading `hasEffectiveDeepPack=true`.

### 3.8 Documentation deliverable

Update integration guide role table and E2E flow to state explicitly:

> **FilixPay = payment + Notify delivery; Payment App = Saleor settlement + (conditional) CMS Deep Pack grant orchestration.**

---

## 4. Decisions log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| OrderLine vs CheckoutLine | **OrderLine only (B)** | CMS handoff frozen; avoids double-grant on replay |
| Missing Order at notify | Short-window poll (A) + structured log + ops replay | Matches return→complete timing; no new infra |
| Notify HTTP vs short window | **200 first; Deep Pack fire-and-forget / post-settlement** | Avoid FilixPay timeout redelivery after settlement |
| `paymentEventId` | `data.tradeNo` | Stable payment fact; not per-delivery `eventId` |
| `readingId` source | **OrderLine.metadata only** | CMS H7; no Order/Checkout fallback in V1 |
| `purchaserUserId` | `Order.user.id` GraphQL global ID | Match CMS Reading USER owner form |
| `PAYMENT_SUCCESS` → CMS state | Map to `filixPaymentState: CONFIRMED` | CMS grant-eligible vocabulary |
| `DEEP_PACK_ALREADY_OWNED` | Commercial exception log, not success | CMS H12 |
| Architecture | Modular `iching-deep-pack/` | Testable; mirrors metadata-patch isolation |
| Durable outbox | Deferred | Revisit if short window miss rate is high |

---

## 5. Open implementation notes (non-blocking)

- Confirm Saleor app token permissions can read `Order.user.id` and **line** metadata on the notify path (same APL token as today).
- Guest checkouts without `Order.user` fail-closed (WARN) — out of V1 Deep Pack scope while CMS requires USER owner.
- If serverless freezes work after `res.end()`, validate that `void tryDeepPack…` still runs long enough for poll+POST, or document a minimal in-process budget; prefer measuring on the deployed platform.
- Poll timings may be tightened after measuring production behavior; they must not re-block Notify 200.

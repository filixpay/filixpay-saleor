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

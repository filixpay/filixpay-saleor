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

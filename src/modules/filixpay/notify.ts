import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";
import { TransactionEventTypeEnum } from "../../../generated/graphql";

const notificationSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.string().min(1),
  timestamp: z.string().min(1),
  apiVersion: z.string().optional(),
  data: z.object({
    amount: z.number().nonnegative(),
    paidAt: z.string().optional(),
    tradeNo: z.string().min(1),
    currency: z.string().min(1),
    merchantOrderId: z.string().min(1),
    channelTransactionId: z.string().optional(),
  }),
});

export type FilixPayNotification = z.infer<typeof notificationSchema>;

export function parseFilixPayNotification(rawBody: string): FilixPayNotification {
  return notificationSchema.parse(JSON.parse(rawBody));
}

export function verifyFilixPaySignature(rawBody: string, signature: string, secret: string) {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signature);

  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

export function mapFilixPayEventToSaleorEvent(notification: FilixPayNotification) {
  switch (notification.eventType) {
    case "PAYMENT_SUCCESS":
      return TransactionEventTypeEnum.ChargeSuccess;
    default:
      return TransactionEventTypeEnum.Info;
  }
}

export function getTransactionTokenFromMerchantOrderId(merchantOrderId: string) {
  return merchantOrderId.startsWith("SALEOR-") ? merchantOrderId.slice("SALEOR-".length) : null;
}

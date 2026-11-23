import { z } from 'zod';

// Providers commonly refuse messages over 25 MB, attachments included.
export const MAX_SEND_BYTES = 25 * 1024 * 1024;

export const recipientSchema = z.object({
  name: z.string().max(200).nullable().default(null),
  address: z.email().max(320),
});

export const outgoingAttachmentSchema = z.object({
  blobKey: z.string().min(1).max(500),
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(0),
});

// mail -> connector: one message to send from an account, with its Message-ID fixed up front so
// the copy in Sent can be found and a retry never sends a second, different message.
export const sendPayloadSchema = z.object({
  outboxId: z.uuid(),
  messageId: z.string().regex(/^<[^<>\s]+@[^<>\s]+>$/),
  to: z.array(recipientSchema).max(100),
  cc: z.array(recipientSchema).max(100),
  bcc: z.array(recipientSchema).max(100),
  subject: z.string().max(998),
  html: z.string().max(5_000_000),
  text: z.string().max(2_000_000),
  inReplyTo: z.string().max(998).nullable(),
  references: z.array(z.string().max(998)).max(100),
  attachments: z.array(outgoingAttachmentSchema).max(50),
});

export type Recipient = z.infer<typeof recipientSchema>;
export type OutgoingAttachment = z.infer<typeof outgoingAttachmentSchema>;
export type SendPayload = z.infer<typeof sendPayloadSchema>;

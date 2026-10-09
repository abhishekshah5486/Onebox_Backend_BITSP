import { describe, expect, it } from 'vitest';
import { sendPayloadSchema } from './send';

const payload = {
  outboxId: '6f1c2b8e-1a4d-4c7e-9b1a-2f3e4d5c6b7a',
  messageId: '<6f1c2b8e@onebox.app>',
  to: [{ address: 'priya@acme.example' }],
  cc: [],
  bcc: [],
  subject: 'Pricing',
  html: '<p>Hi</p>',
  text: 'Hi',
  inReplyTo: null,
  references: [],
  attachments: [],
};

describe('send payload', () => {
  it('fills in missing recipient names', () => {
    expect(sendPayloadSchema.parse(payload).to).toEqual([
      { name: null, address: 'priya@acme.example' },
    ]);
  });

  it('rejects malformed addresses and Message-IDs', () => {
    expect(sendPayloadSchema.safeParse({ ...payload, to: [{ address: 'nope' }] }).success).toBe(
      false,
    );
    expect(sendPayloadSchema.safeParse({ ...payload, messageId: 'abc' }).success).toBe(false);
  });
});

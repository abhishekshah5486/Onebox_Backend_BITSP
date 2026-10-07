import { describe, expect, it } from 'vitest';
import { makeSnippet, parseMessage } from './parse';

const mime = (lines: string[]) => Buffer.from(lines.join('\r\n'));

describe('parseMessage', () => {
  it('extracts headers, addresses and a snippet from a plain message', async () => {
    const parsed = await parseMessage(
      mime([
        'From: "Priya Sharma" <Priya@Acme.example>',
        'To: me@gmail.com, "Ops" <ops@acme.example>',
        'Cc: boss@acme.example',
        'Subject: Demo next week?',
        'Message-ID: <m1@acme.example>',
        'Date: Tue, 06 Oct 2026 10:00:00 +0000',
        '',
        'Hi,\r\n\r\nAre you free for a demo next Tuesday?',
      ]),
    );

    expect(parsed).toMatchObject({
      messageIdHeader: '<m1@acme.example>',
      from: { name: 'Priya Sharma', address: 'priya@acme.example' },
      to: [
        { name: '', address: 'me@gmail.com' },
        { name: 'Ops', address: 'ops@acme.example' },
      ],
      cc: [{ name: '', address: 'boss@acme.example' }],
      subject: 'Demo next week?',
      snippet: 'Hi, Are you free for a demo next Tuesday?',
      htmlBody: null,
    });
    expect(parsed.sentAt?.toISOString()).toBe('2026-10-06T10:00:00.000Z');
  });

  it('reads reply threading headers', async () => {
    const parsed = await parseMessage(
      mime([
        'From: a@x.example',
        'Subject: Re: Demo',
        'In-Reply-To: <m1@acme.example>',
        'References: <m0@acme.example> <m1@acme.example>',
        '',
        'Sounds good',
      ]),
    );
    expect(parsed.inReplyTo).toBe('<m1@acme.example>');
    expect(parsed.references).toEqual(['<m0@acme.example>', '<m1@acme.example>']);
  });

  it('sanitizes html bodies and lists attachments', async () => {
    const parsed = await parseMessage(
      mime([
        'From: a@x.example',
        'Subject: Invoice',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p onclick="steal()">Your invoice</p><script>alert(1)</script><img src="https://t.example/p.gif">',
        '--b1',
        'Content-Type: application/pdf; name="invoice.pdf"',
        'Content-Disposition: attachment; filename="invoice.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('%PDF-1.4 fake').toString('base64'),
        '--b1--',
      ]),
    );

    expect(parsed.htmlBody).toContain('Your invoice');
    expect(parsed.htmlBody).not.toMatch(/onclick|script/);
    expect(parsed.hasRemoteImages).toBe(true);
    expect(parsed.snippet).toBe('Your invoice');
    expect(parsed.attachments).toEqual([
      { filename: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 13, inline: false },
    ]);
  });

  it('copes with a message that has no headers worth reading', async () => {
    const parsed = await parseMessage(mime(['', 'just a body']));
    expect(parsed).toMatchObject({
      from: null,
      subject: '',
      messageIdHeader: null,
      snippet: 'just a body',
    });
  });
});

describe('makeSnippet', () => {
  it('collapses whitespace and caps the length', () => {
    expect(makeSnippet('  a\n\n b  ')).toBe('a b');
    expect(makeSnippet('x'.repeat(500))).toHaveLength(200);
  });
});

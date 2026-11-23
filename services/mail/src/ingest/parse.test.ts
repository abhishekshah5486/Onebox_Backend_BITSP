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
    expect(parsed.attachments).toMatchObject([
      { filename: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 13, inline: false },
    ]);
    expect(parsed.attachments[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('builds a clean snippet from html-only mail', async () => {
    const parsed = await parseMessage(
      mime([
        'From: noreply@github.com',
        'Subject: Alerts',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<h2>Dependabot alerts</h2><p>3 new alerts in <b>onebox</b>.</p><img src="https://t.example/p.gif"><a href="https://github.com">View</a>',
      ]),
    );
    expect(parsed.snippet).toBe('Dependabot alerts 3 new alerts in onebox. View');
    expect(parsed.snippet).not.toMatch(/https?:|DEPENDABOT/);
  });

  it('reads an html document sent as the plain-text part as text', async () => {
    const parsed = await parseMessage(
      mime([
        'From: news@example.com',
        'Subject: Program',
        'Content-Type: text/plain; charset=utf-8',
        '',
        '<!doctype html><html><head><title></title><style>p{color:red}</style></head>',
        '<body><p style="margin:0">With the online program</p><p>you can apply today.</p></body></html>',
      ]),
    );
    expect(parsed.snippet).toBe('With the online program you can apply today.');
    expect(parsed.textBody).not.toMatch(/<|color:red/);
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

  // As seen in real mail: preview padding, entities in plain text, and bracketed links.
  it('drops the invisible padding senders add to previews', () => {
    expect(makeSnippet('Fast deliveries. &#847; &#847; &shy; &#8199; &#65279; &#847;')).toBe(
      'Fast deliveries.',
    );
    expect(makeSnippet('Code: MAX\u034f\u00ad\ufeff\u200b to unlock')).toBe('Code: MAX to unlock');
  });

  it('drops html tags left in plain text, even unclosed ones, but keeps other angle brackets', () => {
    expect(
      makeSnippet('All set to explore. <img src="https://t.example/x width="198" alt="Logo'),
    ).toBe('All set to explore.');
    expect(makeSnippet('Thanks <3 from <John> <br/>team')).toBe('Thanks <3 from <John> team');
  });

  it('decodes entities in plain-text parts', () => {
    expect(makeSnippet('Thanks for applying&nbsp; We &amp; you')).toBe(
      'Thanks for applying We & you',
    );
  });

  it('leaves out links written as Text<https://…>', () => {
    expect(
      makeSnippet(
        'Google Developer Program<https://c.gle/ACT4xY> is here <mailto:a@b.c> <https://u.com/ >',
      ),
    ).toBe('Google Developer Program is here');
  });
});

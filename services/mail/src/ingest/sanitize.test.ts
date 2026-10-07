import { describe, expect, it } from 'vitest';
import { sanitizeEmailHtml } from './sanitize';

const clean = (html: string) => sanitizeEmailHtml(html).html;

describe('sanitizeEmailHtml', () => {
  it.each([
    ['<p>hi</p><script>alert(1)</script>', 'script'],
    ['<img src="x" onerror="alert(1)">', 'onerror'],
    ['<a href="javascript:alert(1)">x</a>', 'javascript:'],
    ['<iframe src="https://evil.example"></iframe>', 'iframe'],
    ['<form action="https://evil.example"><input name="pw"></form>', 'form'],
    ['<svg><script>alert(1)</script></svg>', 'svg'],
    ['<style>body{background:url(https://t.example/p.gif)}</style>', 'url('],
  ])('strips dangerous markup from %s', (html, forbidden) => {
    expect(clean(html).toLowerCase()).not.toContain(forbidden);
  });

  it('keeps layout styles but drops css that loads content', () => {
    const html = clean(
      '<td style="color: red; background: url(https://t.example/p.gif); padding: 4px">x</td>',
    );
    expect(html).toContain('color: red');
    expect(html).toContain('padding: 4px');
    expect(html).not.toContain('url(');
  });

  it('opens links in a new tab without leaking the opener', () => {
    expect(clean('<a href="https://onebox.dev">x</a>')).toBe(
      '<a href="https://onebox.dev" target="_blank" rel="noopener noreferrer nofollow">x</a>',
    );
  });

  it('flags remote images so the client can block tracking pixels', () => {
    expect(sanitizeEmailHtml('<img src="https://t.example/p.gif">').hasRemoteImages).toBe(true);
    expect(sanitizeEmailHtml('<img src="cid:logo">').hasRemoteImages).toBe(false);
  });
});

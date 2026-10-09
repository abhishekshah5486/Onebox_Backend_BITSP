import { describe, expect, it } from 'vitest';
import { findUnsubscribe } from './unsubscribe';

describe('findUnsubscribe', () => {
  it('reads one-click unsubscribe from the headers', () => {
    expect(
      findUnsubscribe(
        {
          unsubscribe: { url: 'https://news.example/u?id=1', mail: 'stop@news.example' },
          'unsubscribe-post': { name: 'List-Unsubscribe=One-Click' },
        },
        null,
        '',
      ),
    ).toEqual({
      url: 'https://news.example/u?id=1',
      mailto: 'mailto:stop@news.example',
      oneClick: true,
      source: 'header',
    });
  });

  it('never treats a plain http link as one-click', () => {
    expect(
      findUnsubscribe(
        {
          unsubscribe: [{ url: 'http://news.example/u' }],
          'unsubscribe-post': { name: 'List-Unsubscribe=One-Click' },
        },
        null,
        '',
      ),
    ).toMatchObject({ url: 'http://news.example/u', oneClick: false });
  });

  it('falls back to an unsubscribe link in the html body', () => {
    const html =
      '<p>Hi</p><a href="https://shop.example/home">Shop</a>' +
      '<a href="https://shop.example/prefs?u=1&amp;t=2"><span>Unsubscribe</span></a>';
    expect(findUnsubscribe(undefined, html, '')).toEqual({
      url: 'https://shop.example/prefs?u=1&t=2',
      mailto: null,
      oneClick: false,
      source: 'body',
    });
  });

  it('scans a huge body of unclosed links quickly and still finds the footer link', () => {
    const html =
      '<a href="x">'.repeat(300_000) + '<a href="https://shop.example/out">Unsubscribe</a>';
    const started = performance.now();
    expect(findUnsubscribe(undefined, html, '')).toMatchObject({
      url: 'https://shop.example/out',
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('finds a link on an unsubscribe line in plain text', () => {
    expect(
      findUnsubscribe(undefined, null, 'Thanks\nTo unsubscribe visit https://x.example/out).'),
    ).toMatchObject({ url: 'https://x.example/out' });
  });

  it('ignores javascript links and mail without any unsubscribe option', () => {
    expect(
      findUnsubscribe(undefined, '<a href="javascript:alert(1)">Unsubscribe</a>', 'Hello'),
    ).toBeNull();
  });
});

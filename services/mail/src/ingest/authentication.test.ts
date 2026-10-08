import { describe, expect, it } from 'vitest';
import { readAuthentication } from './authentication';

const headers = (entries: Record<string, unknown>) => new Map(Object.entries(entries));

describe('readAuthentication', () => {
  it("reads gmail's verdict for spf, dkim and the transport", () => {
    expect(
      readAuthentication(
        headers({
          'authentication-results':
            'mx.google.com; dkim=pass header.i=@insideapple.apple.com header.s=sel; spf=pass (google.com: domain of bounce@insideapple.apple.com) smtp.mailfrom=bounce@insideapple.apple.com; dmarc=pass',
          received: [
            'from mail.apple.com by mx.google.com with ESMTPS id x (version=TLS1_3); Wed, 7 Oct 2026',
            'from internal by mail.apple.com; Wed, 7 Oct 2026',
          ],
        }),
      ),
    ).toEqual({
      mailedBy: 'insideapple.apple.com',
      signedBy: 'insideapple.apple.com',
      encrypted: true,
    });
  });

  it('ignores failed checks and lower headers a sender could have forged', () => {
    expect(
      readAuthentication(
        headers({
          'authentication-results': [
            'mx.example; dkim=fail header.d=bank.example; spf=softfail smtp.mailfrom=bank.example',
            'forged; dkim=pass header.d=bank.example',
          ],
          received: 'from x by mx.example with SMTP; Wed, 7 Oct 2026',
        }),
      ),
    ).toEqual({ mailedBy: null, signedBy: null, encrypted: false });
  });

  it('reports nothing when the server added no results', () => {
    expect(readAuthentication(headers({}))).toEqual({
      mailedBy: null,
      signedBy: null,
      encrypted: null,
    });
  });
});

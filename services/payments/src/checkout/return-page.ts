import type { FastifyInstance } from 'fastify';

const PAGES = {
  paid: {
    title: 'Payment received',
    body: 'Your plan is being activated. You can close this tab and go back to OneBox.',
  },
  portal: {
    title: 'All set',
    body: 'Your payment details are saved. You can close this tab and go back to OneBox.',
  },
  cancelled: {
    title: 'Checkout closed',
    body: "You weren't charged. You can close this tab and go back to OneBox.",
  },
};

const page = ({ title, body }: { title: string; body: string }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · OneBox</title>
<style>
  :root { color-scheme: light dark; --bg: #f8fafd; --card: #fff; --text: #1f1f1f; --muted: #5e5e5e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111; --card: #1e1f20; --text: #e3e3e3; --muted: #a8a8a8; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg);
    color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
  main { background: var(--card); border-radius: 16px; padding: 32px; max-width: 420px; text-align: center;
    box-shadow: 0 1px 3px rgb(0 0 0 / 12%); }
  h1 { font-size: 22px; font-weight: 500; margin: 0 0 8px; }
  p { color: var(--muted); margin: 0; }
</style>
</head>
<body><main><h1>${title}</h1><p>${body}</p></main><script>setTimeout(() => window.close(), 3000)</script></body>
</html>`;

// Public: where Stripe's hosted checkout sends the browser back. The app learns the outcome by
// asking for the checkout's status, so this page only tells the person what happened.
export function registerReturnRoutes(scope: FastifyInstance) {
  scope.get('/stripe', async (request, reply) => {
    const { result } = request.query as { result?: string };
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      )
      .send(page(result === 'paid' || result === 'portal' ? PAGES[result] : PAGES.cancelled));
  });
}

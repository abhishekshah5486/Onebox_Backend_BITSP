#!/usr/bin/env bash
# Registers OneBox's Stripe webhook for a public deployment and saves its signing secret to .env.
# Usage: scripts/stripe-webhook.sh https://api.example.com/api/v1   (needs `stripe login`)
set -euo pipefail

API_URL="${1:?Pass the public gateway URL, e.g. https://api.example.com/api/v1}"
EVENTS="checkout.session.completed,invoice.paid,invoice.payment_failed,customer.subscription.updated,customer.subscription.deleted"

# Reads the new endpoint's signing secret from Stripe's JSON reply.
SECRET_OF='let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{process.stdout.write(JSON.parse(s).secret||"")})'

response=$(stripe webhook_endpoints create \
  --url "${API_URL%/}/webhooks/stripe" \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=invoice.paid" \
  -d "enabled_events[]=invoice.payment_failed" \
  -d "enabled_events[]=customer.subscription.updated" \
  -d "enabled_events[]=customer.subscription.deleted")
secret=$(printf '%s' "$response" | node -e "$SECRET_OF")

case "$secret" in
  whsec_*) ;;
  *) echo "Stripe didn't return a webhook secret; nothing saved." >&2; exit 1 ;;
esac

# Replaces an earlier secret (e.g. from `stripe listen`); the value is never printed.
grep -v '^STRIPE_WEBHOOK_SECRET=' .env > .env.tmp || true
printf 'STRIPE_WEBHOOK_SECRET=%s\n' "$secret" >> .env.tmp
mv .env.tmp .env
grep -q '^PUBLIC_API_URL=' .env || printf 'PUBLIC_API_URL=%s\n' "${API_URL%/}" >> .env
echo "Webhook registered for ${API_URL%/}/webhooks/stripe ($EVENTS)."
echo "Secret saved to .env; run npm run k8s:up to deploy it."

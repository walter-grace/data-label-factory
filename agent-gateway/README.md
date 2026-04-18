# DLF Agent Gateway (Cloudflare Worker)

Public pay-per-call API for AI agents to use Data Label Factory capabilities.
Wraps our Vercel endpoints + Cloudflare Browser Rendering `/crawl` under a
single auth + billing surface.

## Prices

| Route | Cost |
|---|---|
| `POST /v1/crawl` | 1¢ / call (up to 100 pages) |
| `POST /v1/gather` | 1¢ / search |
| `POST /v1/label` | 1¢ / image |
| `POST /v1/train-yolo/start` | 5¢ / job |
| `GET /v1/train-yolo/status/{id}` | Free (already paid) |
| `GET /v1/train-yolo/weights/{id}` | Free (already paid) |
| `GET /v1/balance` | Free |
| `GET /v1/pricing`, `/v1/health` | Free, unauthenticated |

## Agent quickstart

```bash
export DLF_KEY=dlf_...

# Check balance
curl https://dlf-gateway.workers.dev/v1/balance \
  -H "Authorization: Bearer $DLF_KEY"

# Gather images
curl -X POST https://dlf-gateway.workers.dev/v1/gather \
  -H "Authorization: Bearer $DLF_KEY" -H "Content-Type: application/json" \
  -d '{"query":"swimming pools","max_images":30}'

# Label a single image
curl -X POST https://dlf-gateway.workers.dev/v1/label \
  -H "Authorization: Bearer $DLF_KEY" -H "Content-Type: application/json" \
  -d '{"path":"https://...jpg","queries":"swimming pool","backend":"falcon"}'

# Train on a labeled batch
curl -X POST https://dlf-gateway.workers.dev/v1/train-yolo/start \
  -H "Authorization: Bearer $DLF_KEY" -H "Content-Type: application/json" \
  -d '{"query":"swimming pool","epochs":20,"images":[...]}'

# Poll status
curl https://dlf-gateway.workers.dev/v1/train-yolo/status/abc123 \
  -H "Authorization: Bearer $DLF_KEY"

# Download weights
curl -OL https://dlf-gateway.workers.dev/v1/train-yolo/weights/abc123 \
  -H "Authorization: Bearer $DLF_KEY"
```

## Deploying (operator)

```bash
cd worker-gateway
npm install
# Create KV namespace and update wrangler.toml with the id
npx wrangler kv namespace create KEYS

# Set secrets
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_API_TOKEN      # scoped: Browser Rendering: Edit
npx wrangler secret put ADMIN_KEY          # any strong random token

# Deploy
npm run deploy
```

## Issuing keys (admin)

```bash
# Create a key with $5.00 starting balance
curl -X POST https://dlf-gateway.workers.dev/v1/admin/keys \
  -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"label":"agent:claude","balance_cents":500}'

# Top up by $10
curl -X POST https://dlf-gateway.workers.dev/v1/admin/keys/dlf_xxx/topup \
  -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"amount_cents":1000}'
```

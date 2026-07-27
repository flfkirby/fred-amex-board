# Amex Spend Board

Live spend dashboard for the joint Amex, reading the Google Sheet directly. Same architecture as `fred-ops-board`: single `worker.js` serving frontend + REST API + MCP server, Cloudflare KV, dashboard-set secrets, push-to-deploy via Workers Builds.

## Architecture

- **Runtime**: single Cloudflare Worker (`fred-amex-board`) — frontend, REST API, MCP all in `worker.js`
- **Storage**: KV bound as `AMEX_KV` — `amex:cache:v1` (10-min sheet cache), `amex:settings` (benchmark override)
- **Source data**: joint Amex Google Sheet, read via Google Sheets API with a service account (viewer access). Month tabs auto-detected Jan–Dec; rows count only where Who ∈ {K,B,F} and Amount > 0 (summary rows/refunds excluded)
- **Auth**: `BOARD_TOKEN` env var set in the Cloudflare dashboard (`keep_vars = true` so it survives deploys). Access via `X-Board-Token` header or `?key=` param; wrong/missing token → 404
- **CI/CD**: GitHub repo connected to Cloudflare Workers Builds — push to `main` auto-deploys

## Interfaces

- **Frontend** `/?key=TOKEN` — dashboard: month cards (Fred/Francesca/Joint + averages), burn bar vs benchmark, clickable stacked trend, categories, top transactions
- **REST** — `GET /api/data` (`?fresh=1` bypasses cache), `GET /api/months`
- **MCP** — Streamable HTTP JSON-RPC at `/mcp?key=TOKEN`, 4 tools: `get_spend`, `get_month`, `refresh_data`, `set_benchmark`

## Setup

1. **Google service account** (one-off): console.cloud.google.com → enable **Google Sheets API** → create service account (no roles) → add a JSON key → share the Amex sheet with the service account email as **Viewer**.
2. **KV**: `wrangler kv namespace create AMEX_KV` → paste the returned id into `wrangler.toml`.
3. **Secrets** (Cloudflare dashboard → Worker → Settings → Variables, matching the ops board pattern):
   - `BOARD_TOKEN` — random string (`openssl rand -hex 12`)
   - `GOOGLE_SA_EMAIL` — `client_email` from the JSON key
   - `GOOGLE_SA_KEY` — `private_key` from the JSON key (paste whole value incl. `\n`s)
4. **First deploy**: `wrangler deploy`, then connect the GitHub repo in Cloudflare (Workers & Pages → fred-amex-board → Settings → Build) so pushes to `main` auto-deploy.
5. Open `https://fred-amex-board.<subdomain>.workers.dev/?key=TOKEN` and bookmark.

## Connecting Claude via MCP

Add a custom connector in Claude with URL `https://fred-amex-board.<subdomain>.workers.dev/mcp?key=TOKEN` — then Claude can read spend data (`get_spend`, `get_month`), force refreshes, and adjust the benchmark, same as it manages the ops board.

## Known quirks (inherited patterns)

- Never commit the Google JSON key file — secrets live in the dashboard only.
- Stale-session tool caching applies here too: tools added mid-session need a fresh connection.

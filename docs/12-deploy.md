# 12 — Deploy (Cloudflare)

Superpipeline deploys as **one Worker** that serves both the API (`/v1`, `/auth`, `/mcp`, `/health`) and
the web SPA (static assets, same-origin). Same-origin means the session cookie and the app's relative
`fetch`es just work — no CORS, no cross-site cookies.

## Continuous deploy (the normal path)

Merging to `main` auto-deploys. The `deploy` job in `.github/workflows/ci.yml` runs after the `test`
and `e2e` jobs pass on a push to `main`: it migrates the remote D1 and runs `wrangler deploy
--var DEV_AUTH:false` (belt-and-braces — dev auth is off by default, see below). It needs one repo
secret:

- **`CLOUDFLARE_API_TOKEN`** — a Cloudflare API token with **Workers Scripts: Edit** and **D1: Edit**,
  scoped to your account (a single-account token lets wrangler infer the account). Add it under
  *Settings → Secrets and variables → Actions*.

So the day-to-day flow is: open a PR → tests run → merge → it builds, migrates, and ships to
app.superpipeline.dev automatically — `superpipeline.dev` is a separate static site, see
`14-splitting-app-and-marketing-hosts.md`. The manual steps below are only for first-time setup or one-off deploys.

## Prerequisites (you)

1. **Authenticate wrangler** (interactive):
   ```
   wrangler login
   ```
2. **Create a GitHub OAuth app** — https://github.com/settings/developers → *New OAuth App*:
   - Application name: `Superpipeline`
   - Homepage URL: your deployed origin (e.g. `https://superpipeline-api.<your-subdomain>.workers.dev`)
   - **Authorization callback URL**: `<origin>/auth/callback`
   - Note the **Client ID** and generate a **Client secret**.

   The origin isn't known until the first deploy, so: deploy once (step 3), read the URL, then fill
   the OAuth app and `APP_URL` with it.

## Deploy

3. **Create the D1 catalog** and paste its id into `apps/api/wrangler.jsonc` (`database_id`):
   ```
   cd apps/api && wrangler d1 create superpipeline-catalog
   ```
4. **Apply migrations** to the remote DB:
   ```
   pnpm --filter @superpipeline/api db:migrate
   ```
5. **Set secrets** (from `apps/api`):
   ```
   wrangler secret put SESSION_SECRET        # a long random string
   wrangler secret put GITHUB_CLIENT_ID
   wrangler secret put GITHUB_CLIENT_SECRET
   wrangler secret put APP_URL               # the deployed origin, e.g. https://superpipeline-api.<sub>.workers.dev
   wrangler secret put SUPERWITNESS_REPORTER_CREDENTIAL   # optional: <svc_id>:<secret> for run reporting
   ```
6. **Build the web + deploy** (this builds `apps/web/build` and deploys with dev-auth OFF):
   ```
   pnpm --filter @superpipeline/api deploy
   ```

### Dev auth is opt-in

Dev-mode auth (accepting `X-Tenant-Id` / `X-Agent-Id` headers, `?tenant=`, and the
`<tenant>:<agent>:<caps>` MCP bearer as credentials) is **only** on when `DEV_AUTH=true` is passed
explicitly. It is deliberately **not** in `wrangler.jsonc`, so *any* deploy — including a bare
`wrangler deploy` — accepts **only** real auth (GitHub session cookies + `spa_` agent tokens). The
`deploy` script still passes `--var DEV_AUTH:false` as belt-and-braces.

Opting in is per-command: `pnpm --filter @superpipeline/api dev` runs `wrangler dev --var DEV_AUTH:true`,
and the API test runner sets the binding in `apps/api/vitest.config.ts`.

### Reporting runs to superwitness

Every run's status is reported to superwitness's run registry (`POST /v1/runs`). It is off until
`SUPERWITNESS_URL` is set in `apps/api/wrangler.jsonc` `vars`; while it is off, nothing is
queued and nothing is sent.

- **Credential.** `SUPERWITNESS_REPORTER_CREDENTIAL` is a hub service credential,
  `<svc_id>:<secret>`, for a service principal granted `runs:write`. The Worker exchanges it at
  `{HUB_ISSUER}/api/auth/service-token` for a five-minute token. Set it with
  `wrangler secret put`; it is never printed or logged.
- **URL.** `SUPERWITNESS_URL` must be a public `https://` origin. A Worker cannot reach a tailnet
  address.
- **Delivery.** Each board queues reports in its own `run_reports` table, in the same write as
  the run change, and sends them from its alarm in batches of up to 100. The five-minute cron
  sweep is a backstop. Failures back off from 30 s to 1 h, up to 12 attempts; a refused report is
  parked and logged with `metric: "run_reports_dead"`.
- **Backfill and repair.** `POST /v1/admin/superwitness/backfill` with `{"board_id": "brd_…"}`
  (workspace admin or owner) queues one report per existing run on that board. It is safe to
  re-run, and it revives parked reports.

## Switching to the Organization plane (P4)

Until this runs, the four `ORG_PLANE_*` vars are absent and the Worker behaves exactly as before:
it verifies the hub's tokens and signs people in with GitHub. Setting `ORG_PLANE_ISSUER` switches
it to the Organization plane (`apps/api/src/auth/org-plane.ts`) and refuses every hub token —
there is no dual-accept. Setting it with any of the other three missing fails closed (no sign-in,
no bearer of either kind), never back to the hub.

| Var | Production value |
|---|---|
| `ORG_PLANE_ISSUER` | `https://accounts.superjackfruit.com` (exact `iss`) |
| `ORG_PLANE_JWKS_URL` | `https://accounts.superjackfruit.com/api/auth/jwks` |
| `ORG_PLANE_AUDIENCE` | `https://app.superpipeline.dev` (MCP's is this plus `/mcp`) |
| `ORG_PLANE_URL` | `https://accounts.superjackfruit.com` |

`HUB_ISSUER` **stays set**. In plane mode it no longer names an issuer this Worker trusts; it names
the hub's resource, which the web client requests as a second token so the assignee picker can
keep calling the hub's `/api/fleet/dispatchable`.

1. **Preconditions.**
   - The plane serves resources `https://app.superpipeline.dev` and `https://app.superpipeline.dev/mcp`.
   - Client `superpipeline-web` is registered with redirect `https://app.superpipeline.dev/auth/callback`,
     and may request both the app resource and the hub's (`https://hub.agentpod.dev`).
   - Client `supi` exists for the device flow.
   - A service principal for the run reporter exists in the operator's org. It needs a `svc_`
     credential, and the plane must allow it to mint for superwitness's audience.
   - `ent` for the org includes `superpipeline`.
2. **Mapping file** from the hub export: fleet → org, and hub user id → `prn_`
   (`{ "tenants": {…}, "chosenTenants": {…}, "users": {…} }`). It is a deployment's data and is
   never committed. Dry-run it and resolve every conflict, or accept every `unmapped` row in
   writing on the P4 card:
   `bun scripts/repoint-org-plane.ts --mapping map.json --remote`.
   The script never defaults its target: `--remote` or `--local` is required every time.
3. **Freeze** (design §8 step 1). Then, back to back:
   1. `bun scripts/repoint-org-plane.ts --mapping map.json --remote --write` — applies, then
      re-snapshots and refuses to report success unless a fresh plan is empty.
   2. `wrangler secret put SUPERWITNESS_REPORTER_CREDENTIAL` (the plane `svc_` credential).
   3. `wrangler secret put SESSION_SECRET` with a **new** value. This ends every GitHub-era and
      hub-era session, so nobody stays in a personal tenant through a 30-day cookie.
   4. Merge the PR that adds the four `ORG_PLANE_*` values to `apps/api/wrangler.jsonc` `vars`.
      CI deploys it.

   Between steps 1 and 4, hub tokens for re-pointed tenants are refused. That is why this runs in
   the freeze.
4. **Live checks** (record each output on the P4 card):
   - `curl -s https://app.superpipeline.dev/.well-known/oauth-protected-resource/mcp` names the plane
     in `authorization_servers`.
   - A browser sign-in lands on the team's existing boards, not an empty workspace, and the
     assignee picker lists the agents the person may dispatch.
   - `supi login && supi boards` works.
   - A station agent's token claims and completes a card.
   - The reporter drains: the outbox empties, and superwitness shows the run.
   - `claude mcp add --transport http superpipeline https://app.superpipeline.dev/mcp` completes
     consent and lists tools. Its discovery fetch must hit the plane's ROOT
     `/.well-known/oauth-authorization-server`.
   - Switching workspace at the plane, then signing in again, lands on the other workspace's
     boards. A token's `org` is fixed at consent, so a refresh alone never switches.
   - A token for an org without `superpipeline` gets `403 {"error":"product_not_enabled","org":…}`.
5. **Rollback.**
   1. Revert the vars PR.
   2. `bun scripts/repoint-org-plane.ts --mapping map.json --remote --reverse --write`.
   3. Restore the previous reporter credential.

   Tenants created by first sight during the window keep their `org-plane` mapping and are
   invisible in hub mode. List them with
   `SELECT id FROM tenants WHERE external_source = 'org-plane'` before reverting.

## After deploy

- Confirm the callback URL in the GitHub OAuth app matches `<origin>/auth/callback`.
- Visit the origin → "Sign in with GitHub" → you land in your personal workspace's onboarding.
- Connect an agent from the masthead to mint a `spa_` token + copy the `.mcp.json`.

## Local development is unchanged

`pnpm --filter @superpipeline/api dev:setup` (migrate + seed the local D1) then run the web (`:5173`,
Vite) and API (`:8787`, wrangler) separately; Vite proxies `/v1`, `/auth`, `/mcp` to the Worker. The
`dev` script passes `--var DEV_AUTH:true`, so the `tnt_dev` workspace works without signing in.

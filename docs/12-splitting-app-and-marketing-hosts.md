# Moving the app to `app.kaambaan.dev`

**Status:** runbook, written 2026-09-12. Not yet executed — steps 1–7 are the plan, and
this file should be updated with what actually happened as they are done.

`kaambaan.dev` serves both the marketing page and the application. This splits them:
`kaambaan.dev` becomes a static landing site, and `app.kaambaan.dev` serves the Worker.

## Why this needs a runbook

One Worker serves both halves. From `apps/api/wrangler.jsonc`:

```jsonc
"assets": {
  "directory": "../web/build",
  "not_found_handling": "single-page-application",
  "run_worker_first": ["/v1/*", "/auth/*", "/hub/*", "/mcp", "/health"]
}
```

So the API is `kaambaan.dev/v1/*` and everything else is the SPA — one deployment, one
hostname. Moving the app moves the API with it, and four things point at the old origin.

**Both OAuth flows derive their redirect from the request origin**, which is what makes
this tractable — the code follows whichever hostname serves it:

| Flow | Where | Derivation |
|---|---|---|
| GitHub | `auth/routes.ts` | `new URL(request.url).origin` |
| Hub | `auth/hub-oauth.ts` | `env.APP_URL \|\| new URL(request.url).origin` |

`APP_URL` exists, is currently unset, and is the lever for pinning the hub flow.

**The one irreversible moment is GitHub.** An OAuth App has a single authorization
callback URL, so the instant it changes, `kaambaan.dev/auth/login` stops working. (A
GitHub *App* allows several; check which kind this is before starting — the fix is
easier if it turns out to be the latter.) Everything else can run with old and new side
by side, which is why GitHub comes last among the cutover steps.

The hub registry does allow both at once. From `agentpod/apps/hub/src/config.ts`:
"Several URIs for one client: repeat the client key."

## The order

### Phase 1 — additive; nothing breaks

1. **Add `app.kaambaan.dev` as a Custom Domain** on the `kaambaan-api` Worker. Both
   hostnames now serve app and API. `kaambaan.dev` is untouched.
2. **Add the second redirect URI to the hub.** `HUB_OAUTH_CLIENTS` gains
   `kaambaan|https://app.kaambaan.dev/hub/callback`, keeping the existing entry.
3. **Verify on the new host** before going further: sign in, link a hub account, call
   `/mcp`, load a board.

### Phase 2 — cutover

4. **Set `APP_URL=https://app.kaambaan.dev`** on the Worker, so the hub flow pins to the
   new origin regardless of which hostname the request arrived on.
5. **Change the GitHub OAuth callback** to `https://app.kaambaan.dev/auth/callback`.
   From here `kaambaan.dev/auth/login` is broken, which is fine only because step 6
   follows immediately.

### Phase 3 — the apex becomes marketing

6. **Point `kaambaan.dev` at the `kaambaan-site` Pages project.** The static landing in
   `landing/` is already built and deployed to `kaambaan-site.pages.dev`; this is a DNS
   change plus a custom domain on that project.

### Phase 4 — follow-ups, no longer time-critical

7. `packages/cli/src/credential.ts` — `DEFAULT_BASE` to the new host, then a CLI release.
   Existing installs keep working in the meantime via `KAAMBAAN_URL`, which is read
   first; they are stale, not broken.
8. `packages/agent-sdk/README.md`, the root `README.md`, and `docs-site/` where they name
   the origin.
9. Remove `kaambaan|https://kaambaan.dev/hub/callback` from the hub registry once nothing
   presents it.

## What breaks if the order is wrong

- **GitHub callback changed before `app.kaambaan.dev` serves the Worker** — nobody can
  sign in on either host.
- **Apex pointed at Pages before the callback moves** — `/auth/*` stops existing on the
  only hostname GitHub will redirect to.
- **`DEFAULT_BASE` shipped before the app moves** — every CLI install points at a host
  that does not serve the API yet.

## Rollback

Phases 1 and 2 are reversible: revert the GitHub callback, unset `APP_URL`, and
`kaambaan.dev` serves the app again — both redirect URIs are still registered. After
phase 3 the apex no longer runs the Worker, so rolling back means repointing DNS first.

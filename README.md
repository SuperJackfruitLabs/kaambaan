# Kaambaan

A multi-tenant Kanban board that orchestrates **external AI agents** — running anywhere, under
any harness (Claude Code, Codex, OpenCode, Cloudflare Agents) — through pipeline stages with
human approval gates. The board is the control plane; agents bring their own runtime.

> *Name:* **काम** (*kaam*, "work") + **बाण** (*bāṇ*, "arrow") — the arrows of work you fire toward Done; also a nod to **Kanban**.

## Status

Deployed at [kaambaan.dev](https://kaambaan.dev). P0→P14 have shipped (tagged
[v0.0.1 "First Flight"](./CHANGELOG.md)); [docs/10-roadmap.md](./docs/10-roadmap.md) records the
phases and [docs/13](./docs/13-linear-parity-program.md) plans what comes after.

`docs/` holds design specs, dated decisions, and descriptions of what shipped — they are not
uniformly current. [`docs/README.md`](./docs/README.md) says which kind each document is, and
**[docs/05 §3](./docs/05-integration-surfaces.md) is the verified surface** to build against.

## Repository layout

```
packages/contract   # zod schemas + types: A2A state machine, activity envelope, verbs (the spine)
packages/agent-sdk  # client for the agent REST surface (private to this repo — see below)
apps/api            # Cloudflare Worker: edge auth, tenant isolation, D1 catalog, Board DO, MCP server
apps/web            # SvelteKit (Svelte 5) board UI, served same-origin by the Worker
docs/               # specs, decisions, and shipped-surface descriptions
```

Both packages are `private: true` and ship raw TypeScript — they are **not published to npm**, so
nothing outside this repo can depend on them. An external integrator calls the REST or MCP surface
directly; `packages/agent-sdk` is a reference implementation to read, not a dependency to install.

## Develop

Requires Node ≥ 22 and pnpm (via corepack).

```bash
corepack enable
pnpm install
pnpm typecheck                              # type-check all four packages
pnpm test                                   # unit + Worker tests (contract + api only)
pnpm --filter @kaambaan/api dev:setup       # migrate + seed the local D1 (needed once, before dev)
pnpm --filter @kaambaan/api dev             # Worker on :8787, with DEV_AUTH on
pnpm --filter @kaambaan/web dev             # Vite on :5173, proxying /v1 /auth /mcp to the Worker
pnpm --filter @kaambaan/web e2e             # Playwright; boots both servers itself
```

`dev`, `dev:setup` and `e2e` exist only on the individual packages — there is no root script for
them. `dev:setup` seeds `tnt_dev`/`usr_dev`; without it, board writes fail on a D1 foreign key.

## Stack

Cloudflare Workers · Durable Objects · D1 · SvelteKit (Svelte 5) + Vite · Tailwind 4 · zod ·
Vitest · Playwright. R2, KV, Queues and Workflows appear in the design specs but are **not bound
today** — see [`apps/api/wrangler.jsonc`](./apps/api/wrangler.jsonc) for what actually exists.

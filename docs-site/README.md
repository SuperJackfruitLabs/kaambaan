# kaambaan docs site

The user-facing documentation published at `docs.kaambaan.dev`. Astro + Starlight.

```sh
npm install
npm run dev     # local preview
npm run build   # -> dist/
```

## Why this is not a pnpm workspace member

**It uses npm, and it lives outside `apps/` and `packages/` on purpose.** Both are
load-bearing, and neither is a style preference.

The site is Astro 7, which brings Vite 8. When it participates in the shared pnpm
tree, the root `vitest` re-resolves against that Vite, `@cloudflare/vitest-pool-workers`
can no longer find its runner, and the **entire `apps/api` suite fails to collect** —
556 tests, on a change that touches no product code. Verified both ways on a clean
tree on 2026-09-12: as a workspace member `apps/api` cannot run at all; outside it,
`apps/api` passes 556.

Excluding it with a `!apps/docs` negation in `pnpm-workspace.yaml` was tried and
rejected. The negation does remove it from the project list, but a `node_modules`
directory inside a globbed path still perturbs the tree pnpm builds: with the site's
own `node_modules` present, `pnpm install` produced a broken tree and `apps/api`
failed again. Living outside the `apps/*` glob removes that whole class of problem —
`pnpm install` and this site's `npm install` cannot interact at all, in either order.

The site ships nothing the Worker, the web app or the contract import, so it has no
claim on their dependency resolution.

## Claims are checked

`packages/docs-check` reads the pages under `src/content/docs` and fails CI if they
name a tool, capability or environment variable the codebase does not define. Prose
about the product is checked against the product. Run it with `pnpm -F @kaambaan/docs-check test`.

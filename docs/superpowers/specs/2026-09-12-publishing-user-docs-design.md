# Publishing user docs on `docs.<product>.dev`

**Date:** 2026-09-12
**Products:** kaambaan, AgentPod, supermessage — one site each
**Status:** Spec. Nothing built.

## What gets published, and what does not

**The docs in these repositories today are developer docs and they stay here.** kaambaan's
fifteen numbered files are a domain model, an agent contract, a testing strategy; AgentPod's are
a deployment runbook and an operating manual. They are written for somebody changing the code,
they assume the code is at hand, and publishing them verbatim would produce a public site
documenting internals.

What gets published is a **different audience**: the person *using* the product, and the
developer *integrating* with it. Two audiences, one site each, because the second is a user too
— an agent author reading the MCP contract is using kaambaan, not maintaining it.

The internal docs remain the source the published ones are written from, and they remain
authoritative when the two disagree. A published page that contradicts `docs/04` is a bug in the
published page.

## One site per product, and why not one site for the suite

`charter → README.md` is explicit: *"Each product must stand alone… Nothing here may make one of
them require another to function."* A single `docs.superjackfruit.dev` would make three
independent products share a publishing pipeline, a navigation, and a release cadence. The
charter's own reason for existing is that these are sovereign parties with agreements between
them, not one system.

So: three sites, three repos, three deploys. Cross-links between them are ordinary links.

## Hosting, settled by precedent

`console.agentpod.dev` is **already a Cloudflare Pages site on a Porkbun-DNS domain**, reached by
a CNAME to `agentpod-console.pages.dev`. That answers the question the domain split appeared to
raise:

| site | DNS today | how it gets published |
|---|---|---|
| `docs.kaambaan.dev` | Cloudflare (`gail.ns.cloudflare.com`) | Pages project + CNAME, same zone |
| `docs.agentpod.dev` | Porkbun | Pages project + CNAME at Porkbun — exactly what `console` does |
| `docs.supermessage.dev` | Porkbun | the same |

**No nameserver migration.** Porkbun keeps the zone; Cloudflare serves the site. The one real
difference is that a Porkbun-hosted zone gets no Cloudflare proxying, which for static docs costs
nothing.

## Tooling, also settled by precedent

**Astro.** `apps/landing` in AgentPod is already Astro 5 with MDX and Tailwind 4, built by
somebody on this project, and a second framework would be a second thing to learn for no gain.
Astro's docs-specific preset (Starlight) is the natural fit and is an Astro integration rather
than a different stack.

Rejected: VitePress and Docusaurus, both fine and both a new dependency tree for a project that
already runs Astro. A hand-rolled Worker rendering markdown was considered and rejected for the
opposite reason — it is less work to start and more to maintain, and search alone would justify
the preset.

## What each site carries

Three sections, in the order a reader needs them:

1. **Start** — what the product is, what it is for, and the shortest path to it doing something.
2. **Use** — the surfaces a person operates: the board, the console, the client, the CLIs.
3. **Build on it** — the contracts a developer integrates against: kaambaan's agent contract and
   MCP tools, AgentPod's hub API and MCP tools, supermessage's event schemas.

Section 3 is where the internal docs are closest to publishable, and even there they are rewritten
rather than copied: `docs/04-agent-contract.md` explains a design to a maintainer, and an agent
author needs the same facts in the order they will need them.

## The rule that keeps this honest

Published pages make the same kind of checkable claims the internal ones do — tool names, route
paths, CLI verbs — and they will rot the same way. `packages/docs-check` already holds kaambaan's
internal docs to the code; **it must cover the published pages on the same terms, or publishing
doubles the surface that can go stale while halving the fraction anything checks.**

AgentPod's `apps/landing` is the warning. Its README records that both of its two outbound links
were 404s, because they were "ordinary links with no test behind them".

## Open, and deliberately not decided here

- **Whether supermessage publishes at all yet.** It has four internal docs, no user-facing
  material, and the client is pre-TestFlight. A docs site for software nobody can install yet is
  a page describing a promise.
- **Versioning.** These products have no released versions to document against. Adding version
  switching before there are versions is machinery with nothing to carry.
- **Search.** Worth having, and not worth blocking a first publish on.

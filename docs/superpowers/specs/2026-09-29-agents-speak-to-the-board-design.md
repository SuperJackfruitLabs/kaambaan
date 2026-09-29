# Agents speak to the board — design

**Status:** proposed. Blocked on #106 (MCP does not check agent token scopes).

An agentpod-driven agent can tell superpipeline two things: a stream of activities, and one
`summary` string. Everything else it might say — *I refused*, *here is the artefact*, *here is the
URL and the commit* — has nowhere to go.

## What it cannot do, and why that produced a false board

`apps/hub/src/services/bridge/dispatch.ts` calls `claim`, `context`, `heartbeat`, `activity`,
`complete`, `fail`, `release`. **Never `block`.** `complete` fires when the turn ends normally and
`fail` when it times out, so **an agent that decides to refuse ends its turn normally and is
recorded as succeeding.**

That is the Press board's second failure exactly. The stage rule read:

> If you genuinely cannot publish, BLOCK this card. Do not complete the run.

coder-kai had no mechanism to obey it. It wrote "## Publication blocked" in prose, the turn ended,
the bridge called `complete`, and the board advanced the card to `published`. The rule was
unobeyable, and the diagnosis that produced it — an agent choosing wrongly — was wrong: there was
no choice to make.

The handoff is built by the bridge, not the agent:

```ts
const handoff = {
  summary: said.join("").slice(0, SUMMARY_LIMIT) || null,  // everything the agent said
  station, session, attempt, contextPeak,                   // telemetry
};
```

So a stage requiring `handoff: ["url", "commit"]` — the check that would have caught the *first*
failure — cannot be satisfied by any agent on this deployment.

## The channel already exists

superpipeline's MCP server exposes the whole agent contract:

```
superpipeline_list_work     superpipeline_complete
superpipeline_claim_card    superpipeline_block
superpipeline_get_card      superpipeline_fail
superpipeline_add_reference superpipeline_release
superpipeline_post_activity superpipeline_submit_for_review
superpipeline_heartbeat
```

and `mcp/auth.ts` accepts a real `spa_` token, *"the same credential the REST surface takes"*.

**Nothing needs building to give agents a voice.** An earlier draft of this proposed teaching the
bridge to parse a structured block out of the agent's final message; that was reinventing a
channel that ships today.

## The design

**The bridge keeps claiming.** It owns dispatch, concurrency and the lease, and none of that
should move.

**The agent gets a token scoped to `run` and not `claim`**, and drives its own outcome over MCP:
`block` when it refuses, `complete` with a structured handoff when it finishes,
`add_reference` for what it produced.

That scoping is the answer to the objection AgentPod's own prompt contract records:

> A harness that tries to drive the board itself has no credential for it, and one that **asks for
> more work would keep a lease open past the card it was claimed for**.

Giving it a credential answers the first clause. A `run`-only scope answers the second: it can
finish the card in hand and cannot ask for another.

**The bridge's `complete` becomes a fallback.** An agent that ended its run explicitly has already
said what happened; the bridge must treat "this run has already ended" as success rather than as
an error to log. An agent that said nothing still gets today's behaviour.

**The prompt changes.** `renderCardPrompt` currently ends:

> Do the work in this workspace, then stop. Your progress is reported to the board for you — do not
> call the board, and do not ask for the next card.

The first half stops being true for an agent holding a credential. The second half stays true and
becomes enforced rather than requested.

## Blocked on

**#106 — MCP does not check agent token scopes.** `requiredScope` is consulted at `index.ts:913`,
inside the REST branch; `/mcp` is handled at line 203 and never reaches it. A `run`-scoped token
can call `superpipeline_claim_card` over MCP today, so the guarantee this design rests on does not
hold until that is fixed. It is the same defect REST already repaired, on the other surface.

## Decisions to take before building

**D1 — how long does the token live?** A long-lived per-agent token follows the station git-identity
precedent (`agentpod#597`) and is simple. A short-lived per-run token is scoped to the card in hand
and cannot be replayed against a later one, at the cost of minting machinery.

**D2 — how does the token reach the agent?** The git identity is injected as `GIT_SSH_COMMAND` when
the node SPAWNS a process over ACP — and the guild agents are long-lived `hermes` services that
are never spawned that way, which is why that injection reached none of them and a system-wide
`ssh_config` was needed instead. A token has no equivalent of `ssh_config`. This is the wrinkle
most likely to be discovered late.

**D3 — does the agent keep `claim` as well?** Run-only is right for the pipeline as it stands.
Stage 3 of the operator's arc — a self-directed backlog, where an agent picks its own next card —
needs `claim`, and then the lease concern above becomes real rather than theoretical.

**D4 — what should an agent's `post_activity` do to the coalesced stream?** The bridge already
projects ACP events into activities. An agent posting its own would interleave two authors on one
log, and the ordering between them is not obviously defined.

## What this is not

It does not make an agent honest — it gives an honest agent somewhere to be honest. An agent that
calls `complete` with a fabricated URL satisfies the same check either way; that is what slice 3 of
`2026-09-29-evidence-not-assertion-design.md` is for, and only for hosts it may verify.

The point is narrower: **an agent that wants to say "I did not do this" should be able to.**

# Marketing & Community publishing flow design

**Status:** proposed; architecture approval required before implementation or live configuration

**Project:** `prj_34b48f840daa4309`

**Current Marketing board:** `brd_e247f164e060443f`

**Confirmed X identity:** `rakesh_gangwar1` / `99980855` (read identity only; this is not proof of write authority)

## 1. Decision

Use three independent, project-linked SuperPipeline boards, all using the existing specialist roster, plus one narrowly scoped X publication tool on the existing AgentPod execution path:

1. **LinkedIn editorial** — selective, manual publication and manual permalink capture.
2. **X editorial and publication** — event-driven intake, exact-payload approval, automatic claim by the existing AgentPod bridge, deterministic X execution, reconciliation, and read-back verification.
3. **Community feedback** — Anna's source-linked findings, reply drafts, and product/docs recommendations; terminally draft-only.

Do not simulate branching or lane skipping inside the current single sequential board. SuperPipeline advances to the next ordered stage (`BoardDO.advanceCard`); an approved gate advances to that next stage (`BoardDO.resolveGate`). Separate cards on separate boards are therefore the smallest supported isolation boundary for independently terminating LinkedIn, X, and feedback work.

The current Marketing board remains unchanged during design and initial implementation. Its two canaries and their gates remain untouched. Operators create the three boards from reviewed definitions, route only new work to them, and decide later whether the legacy board is archived or retained as intake history.

### Selected approach, end to end

| Path | Intake and selection | Production and review | Human authority | Execution and terminal evidence |
|---|---|---|---|---|
| LinkedIn | Weekly planning cards plus suitable event nominations; Melissa selects only stories that warrant LinkedIn | Quill writes LinkedIn-native copy, Artistic Lyra supplies optional media, Echo checks claims and sources | Rakesh approves the LinkedIn revision only | Rakesh/operator publishes manually; the card is not complete until a manually supplied public permalink and timestamp are recorded |
| X | Shipped outcome, useful demo, decision, lesson, or verified failure creates an event card; Melissa selects angle, audience, sequence, or `no_publication` | Quill writes one post or an ordered thread, Lyra supplies optional media, Echo checks claims, deterministic freeze produces the revision/digest | Rakesh approves the rendered X payload for account `99980855` | Gate approval advances to `x-publish`; `work.available` accelerates pickup and the normal AgentPod claim poll is the fallback, so no second manual dispatch is required. The deterministic publisher completes only after public read-back |
| Community | Scheduled or event-driven collection creates evidence work | Anna records source-linked findings, reply drafts, and product/docs recommendations | Human review is terminal and grants no publishing authority | No outbound capability exists. A future reply must become a new channel-specific card with its own exact target/text approval and supported publisher |

The shared join key is a canonical `storyId`/event ID, not a shared mutable content record. Cards carry the same project ID and related-card links, allowing one story to have independently owned LinkedIn, X, and feedback states without making one channel's approval authorize another.

### Conflicts resolved from earlier stages

- The requirement for automatic post-approval X execution does **not** authorize branching or a direct gate webhook that writes to X. The supported resolution is ordinary gate advancement to the next ordered stage, followed by the existing atomic claim path; push is only an accelerator.
- The desire for one cross-channel calendar does **not** justify one superset board. The risk review favored three isolated linear boards and one project-linked reporting view because current SuperPipeline routing is next-stage only.
- Tuesday/Friday are retained only as proposed LinkedIn planning slots. No schedule is installed until Rakesh/operator selects it.
- `xurl whoami` established read identity only. It is not treated as proof of write scope, credential isolation, or production readiness.
- The previous risk review is controlling where convenience conflicts with safety: live X remains paused until mandatory controls M1–M9, the no-write suite, operator policy choices, credential review, and a separately approved live canary all pass.

## 2. Goals and invariants

### Goals

- Publish zero or more warranted X posts per day from shipped outcomes, useful demos, decisions, lessons, and verified failures.
- Prepare two selective LinkedIn posts per Asia/Calcutta week for manual publication, without copying every X story.
- Turn community evidence into source-linked reply drafts and product/docs recommendations without automatic engagement.
- Make every public write attributable to an exact human-approved payload revision and a narrowly scoped account.
- Report X success only after read-back verifies public truth.

### Invariants

1. **An approval names one immutable payload.** The approved digest covers channel, account, ordered text, media, targets, timing, and expiry. A changed covered field creates a new revision and requires a new gate.
2. **Channel authority does not cross.** LinkedIn approval never authorizes X; X approval never authorizes LinkedIn; a community-reply approval would be a separate future route and payload.
3. **The publisher does not write prose.** Melissa selects audience, angle, channel, and sequence; Quill supplies final platform-native copy; Lyra supplies optional media; Echo supplies claim/source verdicts. The execution tool accepts or rejects that package verbatim.
4. **A POST response is not success.** Only public read-back of the expected author, ordered text, media, and targets makes a step verified.
5. **Ambiguity is reconciled before another write.** Timeout, process crash, lease loss, or lost response after a request may have created a post. The next attempt reads public/account state first.
6. **Recurrence creates work, not authority.** A schedule may create a planning/collection card. It cannot mint a payload revision, approve it, or publish it.
7. **Feedback is not engagement.** Anna may draft a reply; no reply, quote, DM, like, repost, follow, or other engagement is executed by this design.
8. **Human and admin credentials are never repurposed.** Board administration, roster changes, gate resolution, and X publication use distinct operator-owned authorities.

## 3. Why three boards

SuperPipeline's shipped orchestration is linear:

- `advanceCard` uses `stages[idx + 1]`, not a route expression.
- A pending approval gate records `gateId`, producer, deciding actor, decision, and comment; approval then calls `advanceCard`.
- `work.available` is an accelerator. It is emitted only for a claimable capability/agent-owned stage; the atomic claim remains the authority.
- AgentPod already polls `claims`, receives `runId` and `leaseEpoch`, heartbeats, and stops on stale lease or a foreign run.

A single superset pipeline would make LinkedIn cards traverse an X publisher and X cards traverse a manual-permalink lane. Conditional no-op stages would hide the real workflow and enlarge the blast radius of one stage-definition mistake. Three boards cost some duplicated stage definitions, but preserve independently enforceable gates and terminal conditions using the product's existing ordered-stage model.

## 4. Boundary and ownership

### Inside this change

- Three board definitions and project-link conventions.
- A canonical publication-package schema and digest algorithm.
- An AgentPod-hosted, deterministic X publisher tool with its own durable ledger.
- A machine-readable xurl adapter contract for identity, upload, create, and read-back.
- New mock/no-write and operator-approved live acceptance fixtures.
- Operator runbooks for pause, kill, stale approval, reconciliation, and LinkedIn permalink capture.

### Outside this change

- LinkedIn API integration or credentials.
- Generic SuperPipeline branching, arbitrary lane skipping, or a new routing language.
- Automatic community replies or unsolicited DMs.
- A new writing/media/research specialist roster.
- Reusing a human browser session, human SuperPipeline session, or organization-plane admin credential for agent writes.
- Treating SuperPipeline completion as proof that X published.
- Scheduled X release unless the approved payload explicitly requests a schedule.
- Any live configuration, credential, gate, canary, or social write during architecture review.

### Accountable owners

| Boundary | Producer | Accountable consumer/owner | Guarantee |
|---|---|---|---|
| Story brief | event adapter or human | Melissa | source URL/event id and observed timestamp are present |
| Channel plan | Melissa | Quill and calendar | explicit `x`, `linkedin`, or `no_publication`; sequence and reason recorded |
| Final copy | Quill | Echo, Rakesh, publisher | ordered platform-native text, no executor rewriting |
| Media manifest | Lyra | Echo, Rakesh, publisher | immutable object ref, MIME/size, SHA-256, alt text |
| Evidence verdict | Echo | Rakesh and publisher | every factual claim maps to sources or is marked opinion/experience |
| Approval | Rakesh | publisher/manual LinkedIn process | actor, gate, revision, digest, decision, timestamp |
| X intent/result ledger | publisher tool | operator and board | fenced single writer, step status, attempt evidence, public IDs/URLs |
| LinkedIn permalink | Rakesh/operator | LinkedIn board/calendar | manually supplied URL and publication timestamp; no API assertion |
| Community finding | Anna | product/docs owner | source link, captured excerpt, recommendation, reply draft is non-public |

## 5. Board designs

All boards belong to `prj_34b48f840daa4309`. Capabilities are illustrative names to be approved and matched to existing agent identities; board creation and roster grants are operator actions.

### 5.1 LinkedIn editorial board

Ordered stages:

1. `select-linkedin-story` — capability `marketing-strategy`, Melissa.
2. `write-linkedin-copy` — capability `social-copy`, Quill.
3. `prepare-linkedin-media` — capability `artistic-media`, Artistic Lyra; may explicitly return `media: []`.
4. `verify-linkedin-claims` — capability `claims-review`, Echo.
5. `approve-linkedin-payload` — human-owned approval gate, Rakesh.
6. `manual-publish-and-capture` — human-owned, gated terminal stage; operator supplies live permalink and publication timestamp before approving completion.

The calendar target is two manually published posts in each Asia/Calcutta week. A weekly planning schedule creates two independent planning cards only after the operator chooses the slots. Tuesday/Friday are proposed planning slots, not defaults silently installed by implementation. Melissa may nominate fewer suitable stories temporarily, but the board records the shortfall and reminder; it must not substitute an unsuitable X post or filler.

Each card carries `weekKey` (ISO-like week evaluated in `Asia/Calcutta`), proposed slot, sources, selection reason, payload revision/digest, due draft time, approval state, reminder state, and eventually the manually supplied live permalink. There is no LinkedIn token or write client.

### 5.2 X editorial and publication board

Ordered stages:

1. `triage-x-event` — capability `marketing-strategy`, Melissa. Accepts shipped outcome, demo, decision, lesson, or verified failure; may mark `no_publication` with reason.
2. `write-x-copy` — capability `social-copy`, Quill. Produces one post or an ordered thread.
3. `prepare-x-media` — capability `artistic-media`, Artistic Lyra; optional.
4. `verify-x-claims` — capability `claims-review`, Echo.
5. `freeze-x-payload` — capability `social-copy`, Quill, but implemented with a deterministic canonicalizer that emits immutable revision `N` and digest.
6. `approve-x-payload` — human-owned approval gate, Rakesh. The gate display must render account, full ordered text, media thumbnails plus checksums, reply/quote targets, timing mode, and expiry.
7. `publish-and-verify-x` — capability `x-publish`, claimed by the existing coordinator's AgentPod loop; its only side-effecting tool is the scoped publisher described below.
8. `published-x` — ungated human-owned terminal lane; arrival completes automatically only after stage 7 returns verified evidence.

`no_publication` is not lane skipping: the same ordered stages return explicit no-op handoffs, and `publish-and-verify-x` refuses a missing approved publish intent and completes with a recorded `not_selected` result. This costs small agent work but avoids inventing branching. If no-op volume becomes material, a later, separate routing feature can be justified with measured data.

There is no daily quota and no one-post-per-day lock. The account fence serializes writes; duplicate/flood policy examines recent intents and verified posts, but it may permit multiple same-day posts when each has distinct approved content and the configured minimum spacing is satisfied. Minimum spacing and burst thresholds are operator policy values, not hard-coded product requirements.

### 5.3 Community feedback board

Ordered stages:

1. `collect-community-evidence` — capability `community-research`, Anna.
2. `analyse-feedback` — capability `community-research`, Anna.
3. `draft-reply-and-recommendation` — capability `community-research`, Anna.
4. `review-feedback` — human-owned, ungated terminal lane or approval gate if product/docs owners request one.

Output fields: source URL/post ID, author as publicly observed, captured timestamp, verbatim excerpt, theme, confidence, affected product/docs area, recommendation, owner, and optional reply draft. `publicationIntent` is fixed to `none`. A reply can leave this board only by creating a new, separately approved publication card whose payload names the exact target and text; that future route is not part of this design. DMs are never generated as actions.

### 5.4 Roster and stage prerequisites

The labels below are proposed capability identifiers. Before board creation, the operator must either confirm that the exact identifier already exists on the named existing agent or substitute the estate's canonical identifier in both the board definition and roster grant. A board must not open intake while any capability stage has zero eligible enabled agents.

| Existing identity | Proposed capability | Boards/stages | Required before intake |
|---|---|---|---|
| Melissa | `marketing-strategy` | LinkedIn selection; X triage/selection/sequencing | Enabled AgentPod roster entry; claim credential limited to the relevant boards/stages |
| Quill | `social-copy` | LinkedIn/X copy; deterministic freeze invocation | Enabled roster entry; no social credential or external-write tool |
| Artistic Lyra | `artistic-media` | Optional LinkedIn/X media preparation | Enabled roster entry; immutable media store access; provenance/checksum/alt-text output; no social credential |
| Echo | `claims-review` | LinkedIn/X evidence review | Enabled roster entry; read-only source access; no social credential |
| Anna | `community-research` | All Community agent-owned stages | Enabled roster entry with no outbound messaging/social tools |
| Existing coordinator | `x-publish` | X `publish-and-verify-x` only | Grant only after no-write acceptance; separate least-privilege SuperPipeline run principal; station-scoped X credential; durable ledger; default-paused account writer |
| Rakesh | human owner/gate decider | Channel-specific approvals and manual LinkedIn publication | Human principal; gate authority scoped to the intended board; never reused by an agent or publisher |
| Product/docs owner | human owner | Community terminal review | Human principal only; no implied reply/publication authority |

Board validation must prove stage order, `ownerKind`, capability string, gate placement, WIP/concurrency, and eligible roster count from the reviewed definition. The three definitions and roster diff are review artifacts; applying them is a separate operator-owned card.

## 6. Canonical approved payload

The canonical JSON object is serialized with a versioned JSON canonicalization implementation (sorted object keys, UTF-8, arrays preserved, no insignificant whitespace) and hashed as `sha256` over the canonical bytes. Text is not trimmed, normalized, or rewritten during canonicalization.

```jsonc
{
  "schema": "social-publish/v1",
  "cardId": "card_…",
  "projectId": "prj_34b48f840daa4309",
  "revision": 3,
  "channel": "x",
  "account": {
    "platform": "x",
    "userId": "99980855",
    "username": "rakesh_gangwar1"
  },
  "items": [
    {
      "index": 0,
      "text": "exact bytes approved by the human",
      "media": [
        {
          "objectRef": "immutable://…",
          "sha256": "…",
          "mime": "image/png",
          "size": 12345,
          "altText": "…"
        }
      ],
      "replyToPostId": null,
      "quotePostId": null
    }
  ],
  "timing": {
    "mode": "immediate",
    "notBefore": null,
    "expiresAt": "2026-10-08T12:30:00Z"
  },
  "evidenceRefs": ["https://…"],
  "policy": {
    "allowThread": true,
    "duplicateWindow": "operator-configured-policy-id",
    "floodPolicy": "operator-configured-policy-id"
  }
}
```

The approval record is separate and immutable:

```jsonc
{
  "gateId": "gate_…",
  "actorPrincipalId": "prn_…",
  "decision": "approve",
  "payloadRevision": 3,
  "payloadDigest": "sha256:…",
  "approvedAt": "…",
  "expiresAt": "…"
}
```

Before every write, the publisher re-canonicalizes the payload it received and requires equality of channel, account ID, revision, and digest with the approval record. Any copy, item order, media object/checksum/alt text, target, account, channel, timing, or expiry change creates revision `N+1`, invalidates the prior gate, and returns the card to `freeze-x-payload`. Source/evidence links may be appended only if they are explicitly outside the signed object; changing a link used to support a claim requires Echo review and a new revision.

## 7. X publisher boundary

### Placement

Add a deterministic module under AgentPod Hub, beside the existing SuperPipeline bridge, rather than adding publication logic to SuperPipeline:

- `apps/hub/src/services/social-publisher/` — payload validation, policy, orchestration, reconciliation, verification.
- `apps/hub/src/db/schema/social-publisher.ts` — intents, steps, media, attempts, and evidence.
- `apps/hub/src/routes/…` only for operator read/pause/kill controls; no public unauthenticated write route.
- existing `services/bridge/dispatch.ts` and roster remain the claim/lease path. The existing coordinator identity receives `x-publish`; it invokes only the deterministic publisher tool for that stage.

SuperPipeline owns editorial state, ordered progression, gate identity, and the project-linked card. AgentPod owns execution state because it owns the station, credential isolation, claim loop, and existing durable dispatch ledger. X owns public truth.

### xurl adapter

Pin a tested xurl version. Use it for `whoami`, media upload/status, create post/reply/quote, and read by post ID. The current source supports those operations but its normal shortcut output does not provide a stable machine envelope containing HTTP status and rate-limit headers, and it has no universal idempotency primitive. Before live use, add or upstream a machine-output mode that returns:

```jsonc
{
  "requestSent": true,
  "httpStatus": 201,
  "headers": {"x-rate-limit-reset": "…"},
  "body": {"data": {"id": "…", "text": "…"}},
  "errorClass": null
}
```

It must not retry POST automatically. The publisher, not xurl, owns retry/reconciliation policy. Tokens stay in the station's secret store and are never copied into card data, activity, logs, or the LLM prompt. The tool always passes the explicit account selector and runs `whoami` before the first write of an intent; default-account fallback is forbidden.

### Ledger

`publish_intent` is unique on `(channel, account_user_id, payload_digest)`. It stores card, revision, digest, gate, approval actor/time/expiry, state, pause generation, claimed run/lease, and timestamps.

`publish_step` is unique on `(intent_id, item_index)` and stores expected text, media checksums, targets, predecessor ID, state (`pending | write_started | response_received | verified | ambiguous | blocked`), public ID/permalink, response hash, and verification evidence.

`publish_attempt` is append-only: attempt number, worker/fence token, operation, started/ended time, request fingerprint, response class, status/rate metadata, and redacted evidence. Media uploads get their own checksum-keyed rows and may be reused only when X confirms the media ID is still valid.

A database transaction acquires an account-scoped advisory lock and compare-and-swaps intent/step state using a monotonically increasing fence token. AgentPod lease loss stops future writes, but the publisher's account fence—not the SuperPipeline lease alone—prevents another process from racing the same account. A reclaimed card first loads the existing intent by digest and reconciles it.

### Execution algorithm

1. Fail closed if global kill, account pause, or intent pause is active.
2. Fetch the run/card/gate read model; require the expected board, stage, project, channel, account, approved decision, revision, digest, actor, and unexpired approval.
3. Recompute media checksums from immutable objects. Refuse missing/mutable/mismatched media.
4. Run explicit-account `whoami`; require ID `99980855` and expected username.
5. Apply duplicate/flood policy to ledger plus recently read public posts. A digest match returns its existing verified result; a near duplicate or burst breach blocks for a human rather than silently rescheduling, unless the approved timing explicitly permits a later release.
6. For each ordered item:
   - verify already recorded `publicId`; if public read-back matches, mark verified and continue;
   - if prior state is `write_started`, `response_received`, or `ambiguous`, reconcile before any POST;
   - upload/check media;
   - persist `write_started` and request fingerprint in the same transaction that advances the fence;
   - issue exactly one create request;
   - persist returned ID/body immediately;
   - read by ID and verify author ID, exact full text, media, reply/quote target, conversation/predecessor relationship, and public permalink;
   - only then mark the step verified.
7. A thread item after index 0 replies to the previously verified item ID. Never construct the next reply from an unverified response.
8. When all steps are verified, attach exact public permalinks to the card, emit the execution result, and complete the SuperPipeline stage. A successful create response without verification blocks or retries reads; it does not complete.

### Ambiguous reconciliation

Use, in order:

1. known returned ID, if persisted;
2. account recent-post read constrained to the attempt time window, exact text, media, reply/quote target, and predecessor/conversation;
3. if exactly one match, record and verify it;
4. if zero matches after bounded read retries, a human must authorize another write unless the failure happened before `requestSent=true` can be proven;
5. if several matches, block for human reconciliation; never guess.

X does not provide universal idempotency, so text search is evidence, not a write key. The ambiguous state is intentionally sticky.

## 8. Failure policy

| Condition | Class | Behaviour |
|---|---|---|
| Approval missing, wrong channel/account, digest mismatch, edited payload, expired approval | human-blocked | no external call; create a new revision/gate |
| Global/account/intent pause | human-blocked | no claim-side write; remain resumable |
| Kill activated before request | non-retry | abort intent; requires a fresh operator decision |
| Kill/lease loss after request may have left process | reconcile-first | read before any further write |
| 401/403, missing scope, wrong account | non-retry/operator | stop loop for that publisher identity; rotate/fix authority |
| Billing/cost/package refusal | human-blocked | no blind retries; operator changes account/package or abandons |
| 429 with usable reset | bounded retry | schedule a read-safe retry after reset plus jitter; do not repeat an ambiguous POST |
| 5xx before proven send | bounded retry | bounded exponential backoff; record each attempt |
| timeout/connection reset after possible send | reconcile-first | persist ambiguous, then read; no immediate POST retry |
| duplicate/flood policy hit | human-blocked or explicit schedule | do not publish filler; schedule only when approved timing permits |
| media processing pending | bounded read retry | poll status; do not recreate the upload while it is valid |
| media rejected/checksum mismatch | non-retry | new media and fresh approval |
| partial thread | reconcile-first/resume | verify existing items; publish only the first verified-unpublished index |
| verification text/author/target/media mismatch | incident/human-blocked | record actual public URL; do not report success or delete automatically |
| SuperPipeline complete times out after all posts verified | board-reconcile | replay the stored verified result to the board; never republish |

## 9. Pause, kill, timing, and reminders

Controls are separate and explicit:

- **Global kill:** disables all social writes and rejects new write attempts.
- **Account pause:** prevents new X writes for `99980855`; reconciliation reads remain allowed.
- **Intent pause:** freezes one payload.
- **AgentPod roster disable:** drain-safe stop of the existing bridge loop. Current AgentPod stops after the in-flight `runOnce`; therefore it is not the emergency kill for a request already executing. The publisher checks the kill generation before every external write.
- **Credential revoke:** last-resort external stop; operator-owned.

`immediate` means publish after approval as soon as the stage is claimed and preconditions pass. `scheduled` requires an approved `notBefore` and `expiresAt`; it is not inferred from calendar slots. SuperPipeline recurrence is used only to create LinkedIn planning/collection cards and periodic community-collection cards. It is never used as an X release timer.

LinkedIn reminders are derived from open project-linked cards: draft overdue, awaiting approval, approved-awaiting-manual-publish, and published-awaiting-permalink. Reminder delivery does not modify approval or publication state.

## 9A. Risk-review resolution: mandatory controls M1–M9

These controls are release blockers, not recommendations. They incorporate the preceding risk review's ordered concerns (irreversible wrong writes, approval-byte mismatch, duplicates/partial threads, timing races, credential scope, route bypass, false verification, unsafe content, and audit loss).

| Control | Requirement | Release evidence |
|---|---|---|
| M1 — Route isolation | Three new linear boards; X gate immediately precedes the publisher; current board/canaries are unchanged; Community has no outbound stage or tool | Reviewed board-definition and roster diffs plus synthetic wrong-board/channel claims |
| M2 — Exact approval binding | One versioned canonicalizer produces the bytes shown at the gate and checked by the executor; account/channel/revision/digest/text/media/targets/timing are covered; every covered edit invalidates approval | Golden canonicalization fixtures and mutation/cross-channel tests |
| M3 — Least authority | Separate human, board-admin, claim/run, and station X principals; no human/admin reuse; explicit account `99980855`; secret redaction and revoke/rotate runbook | Principal/grant inventory, startup/per-write `whoami`, redaction test, credential-owner sign-off |
| M4 — Durable single writer | Transactional intent/step/attempt ledger, unique constraints, account lock, monotonic fence, write-ahead `write_started`, concurrency one | Parallel-claim, lease-loss, crash, constraint, backup/restore, and integrity tests |
| M5 — Reconcile before retry | Returned ID first, then bounded exact recent-output search; zero or multiple matches block; verified thread prefixes are never replayed | Ambiguous timeout and partial-thread fixtures with an assertion that no second POST precedes reconciliation |
| M6 — Public verification | Read by public ID and verify author ID, exact full text under versioned equivalence rules, media, targets, order/relationship, and permalink; POST response alone never completes | Read-back contract fixtures and persisted public IDs/permalinks; unknown schema safely blocks |
| M7 — Pause and timing | Global/account/intent pause plus credential revoke; pause/expiry/not-before/fence rechecked immediately before every item; schedule only if approved | Pause/kill, stale approval, scheduled timing, and narrow in-flight-race runbook tests |
| M8 — Editorial safety | Echo source map, Lyra rights/provenance/checksum/alt text, legal/privacy escalation, duplicate/flood/budget policy; no quota-filling | Missing-evidence/rights tests, policy fixtures, named human owners, and explicit residual-risk acceptance |
| M9 — Staged release and audit | No-write suite first; operator values chosen; live writer stays paused; one separately approved canary; append-only evidence and board/public reconciliation | Signed readiness checklist and live canary package containing gate/revision/digest, intent/step/attempt IDs, public read-back, and pause drill |

If any mandatory control is missing or its evidence is inconclusive, the supported fallback is manual X dispatch from the exact approved payload while the automated writer remains paused. This fallback is not production acceptance because it requires a second human dispatch.

## 10. Data shown on cards

Every channel card records or links:

- source event IDs and evidence URLs;
- Melissa's channel decision, audience, angle, and sequence;
- calendar week/slot when relevant;
- Quill's exact ordered copy;
- Lyra media manifests and checksums;
- Echo verdict and source map;
- immutable payload revision/digest;
- approval actor, gate ID, decision, timestamps, expiry;
- publisher intent/step state and operator pause state;
- public post IDs/permalinks or manual LinkedIn permalink;
- failure classification and next responsible owner.

Large immutable media stays in object storage; the card stores references and digests. Credentials, raw authorization headers, and unredacted xurl traces are forbidden fields.

## 11. Operator-owned changes

These are prerequisites, not implementation shortcuts:

1. Approve this architecture and the three-board boundary.
2. Create the LinkedIn, X, and Community boards under the project with the exact ordered stages above. Do not edit or resolve the two existing canary gates.
3. Confirm whether Tuesday/Friday are the two LinkedIn planning slots; until then install no fixed slot schedule.
4. Register the existing Melissa, Quill, Artistic Lyra, Echo, Anna, and coordinator identities on only the boards/stages they need; verify each capability has a claimable roster entry before opening intake.
5. Add `x-publish` only to the existing coordinator execution identity after code/no-write acceptance. Do not add a new creative specialist.
6. Mint distinct SuperPipeline credentials: claim token for the bridge and run-only token for the harness/tool path. No human/admin token.
7. Provision a station-scoped X app/user credential limited to the confirmed account and required read/media/post scopes. Record owner, rotation, revoke, and billing authority. `whoami` read is not write acceptance.
8. Configure global/account kill controls defaulted to paused and publisher concurrency `1` for the account.
9. Choose approval TTL, immediate/scheduled policy, duplicate window, minimum spacing, burst threshold, retry ceilings, and retention. Values remain explicit operator policy because no measured production volume was supplied.
10. Approve exact live test copy separately. Mocks/no-write stay the only allowed mode until that decision.
11. After acceptance, route new work to the new boards. Preserve legacy board/canaries; migrate or archive only by a later operator decision.

## 12. Code-owned implementation cards

Create these as separate implementation cards after architecture approval; sequence is a dependency chain, not permission to start now.

1. **Publication contract and fixtures** — canonical schema, canonical bytes, digest, revision invalidation, wrong-channel/account fixtures.
2. **xurl machine adapter** — pinned version, explicit account, no automatic POST retry, structured status/rate headers, mock transport, redaction.
3. **Publisher ledger and fences** — migrations, account lock, unique intent/step constraints, append-only attempts, pause/kill generation.
4. **Publisher state machine** — preflight, media, create, read-back verification, failure classification, schedule/expiry.
5. **Ambiguity and thread recovery** — reconcile known/unknown IDs, partial thread resume, complete-timeout replay.
6. **AgentPod tool integration** — expose only the deterministic publisher to the existing coordinator at `x-publish`; retain claim/lease/heartbeat behaviour.
7. **Board definitions and payload renderer** — exact gate view, three board templates, project/card fields, no live install.
8. **LinkedIn planning/reminder/permalink workflow** — two weekly planning-card option, due-state reminders, manual URL capture; no API client.
9. **Community feedback workflow** — Anna template, source requirements, draft-only terminal assertions.
10. **No-write integration suite and operator runbook** — failure matrix, kill drill, audit queries, credential rotation/revocation.
11. **Operator configuration change** — human-owned board/roster/credential/gate actions, run only after cards 1–10 pass.
12. **Live acceptance** — operator-approved exact test payload, one real write, public read-back evidence, cleanup decision; remains human-gated.

## 13. Acceptance evidence

### Mock/no-write first

| Scenario | Required evidence |
|---|---|
| Correct X approval | gate actor/id + revision/digest reaches executor; one create; exact read-back; stage completes without a second manual dispatch |
| Edit after approval | digest changes; zero X calls; new gate required |
| LinkedIn approval presented to X | channel mismatch; zero X calls |
| Wrong X account | `whoami` ID mismatch; zero create calls; operator block |
| Duplicate delivery / parallel claims | one intent and one step write; all other workers read the same verified result |
| Ambiguous network response | `write_started/ambiguous` persists; reads precede any later create |
| Partial thread | verified prefix skipped; only first unverified item may be created |
| 401/403/cost | no retry loop; publisher identity/operator block |
| 429 | reset-aware bounded schedule; no immediate repeated write |
| Human pause/kill | zero new writes after observed generation; in-flight ambiguity reconciled |
| Lease loss | future writes stop; external result reconciled under account fence |
| Stale/time-sensitive approval | zero write after expiry or invalidated timing |
| LinkedIn manual result | approved payload waits for human publication; supplied permalink and timestamp become card evidence |
| Feedback reply draft | source and exact draft exist; no publisher intent or engagement call exists |

### Live acceptance

A human supplies and approves the exact test copy, media, account, targets, timing, and cleanup decision. Evidence must include:

- gate ID, actor, payload revision/digest;
- confirmed account ID from write-capable station context;
- intent/step/attempt IDs;
- X response classification;
- public post ID and permalink;
- read-back author ID, exact full text, media, and target/thread checks;
- board reference attachment and terminal verified result;
- pause/kill drill result.

No success claim is allowed if public read-back is unavailable or mismatched.

### Checkable completion criteria

Each statement below must be answered **yes** with attached evidence before the corresponding implementation/cutover card can complete.

1. **AC-01 — Isolation:** Do reviewed definitions create three project-linked ordered boards, leave `brd_e247f164e060443f` and both existing canary gates byte-for-byte/configuration-identical, and give Community no outbound tool or stage?
2. **AC-02 — LinkedIn cadence:** Does the LinkedIn report compute an `Asia/Calcutta` week, target exactly two selective manual posts, expose due-draft/approval/reminder/permalink states, and treat Tuesday/Friday as unset proposals until a human selects them?
3. **AC-03 — No LinkedIn writer:** Can a test prove that no LinkedIn API credential, publication client, or automatic publication call is present and that approval alone cannot mark a post published?
4. **AC-04 — Event-driven X:** Can distinct approved events produce multiple same-day X intents when policy spacing permits, with neither a one-per-day ceiling nor a quota-filling path, while duplicate/flood/rate/budget controls still block unsafe bursts?
5. **AC-05 — Supported ownership:** Does every agent-owned stage have at least one enabled eligible existing specialist and every human stage/gate name its human owner, with the exact stage-to-roster matrix captured as a reviewed artifact?
6. **AC-06 — Immutable approval:** For the same canonical bytes, do gate renderer and executor produce the same `social-publish/v1` digest; and does mutating account, channel, item text/order, media ref/checksum/alt text/order, reply/quote target, timing, or expiry force revision `N+1` and a fresh gate?
7. **AC-07 — Channel separation:** Do LinkedIn approval replay, wrong-board payload, wrong X account, unknown schema, missing gate, expired gate, and non-approving decision each make zero external write calls?
8. **AC-08 — Automatic claim:** After the correct gate is approved, does the card advance to the X publisher and get claimed through push or normal polling without a second manual dispatch, while the atomic claim remains the authority?
9. **AC-09 — Pause and time:** Do global/account/intent pause, kill generation, approval expiry, and `notBefore` checks run immediately before every item write; and is scheduled release impossible unless the signed payload says `scheduled`?
10. **AC-10 — Durable deduplication:** Under duplicate delivery, two parallel claims, process crash, and lease loss, is there one intent per `(channel, account ID, digest)`, one step per item index, and no duplicate POST?
11. **AC-11 — Ambiguous outcome:** After a possible-send timeout, do all subsequent actions remain read-only until exactly one public match is verified or a human resolves the block, with zero blind write retries?
12. **AC-12 — Partial thread:** After a failure at item `N`, does recovery verify the contiguous public prefix and issue at most the first verified-unpublished item, deriving its reply target from verified item `N-1` and never replaying the prefix?
13. **AC-13 — Error classes:** Do 401/403, wrong account, billing/cost refusal, media rejection, 429, 5xx-before-proven-send, and timeout-after-possible-send follow the failure table exactly, with bounded retry counts and no automatic retry of an ambiguous POST?
14. **AC-14 — Public truth:** Before success, does read-back produce exact post IDs/permalinks and verify author `99980855`, full ordered text under the versioned equivalence rules, media, reply/quote targets, and thread relationships; and does any mismatch/unavailable property prevent completion?
15. **AC-15 — Feedback boundary:** Does Anna's result contain source, excerpt, analysis, recommendation, and optional exact reply draft while producing no publisher intent, DM, reply, quote, like, repost, or follow call?
16. **AC-16 — Traceability:** Does every terminal result retain project/card/story links, sources, channel decision, revision/digest, gate/actor, intent/step/attempt IDs, failure class or verification evidence, and public/manual URLs without secrets?
17. **AC-17 — Recurrence:** Can tests prove recurrence creates only planning/collection cards and cannot create an approval, resolve a gate, schedule an unapproved X release, or mark a platform publication complete?
18. **AC-18 — Mock-first acceptance:** Does the no-write suite cover every scenario in the table above and pass before any write credential is enabled, and does live mode remain paused until a human separately approves the exact canary payload?
19. **AC-19 — Live canary:** For the separately approved canary, is there one automatic write after approval and evidence for gate/actor/revision/digest, account, intent/step/attempt, response class, exact public read-back, reference attachment, and pause/kill drill?
20. **AC-20 — Operator decisions:** Before cutover, are accountable owners plus approval TTL, duplicate window, spacing/burst, retry, budget, retention, manual-account-use coordination, credential revoke/rotate, and LinkedIn slots explicitly recorded rather than inferred from defaults?

## 14. Scale assumptions and change thresholds

No measured traffic was supplied. Initial design assumes one X account, human-scale editorial volume, and a single account writer. The database and account-scoped lock are deliberately simpler than a new queue/broker.

Revisit the design when any of these become true:

- more than one publishing account or organization requires independent credential tenancy;
- sustained write demand requires parallel account writers rather than concurrency `1`;
- ambiguous reconciliations become frequent enough that recent-post matching is operationally noisy;
- no-op `no_publication` cards consume material specialist capacity;
- scheduled releases require a durable timer service beyond explicit payload timing;
- another platform needs automated publication.

At that point, extract a multi-account publication service or add supported SuperPipeline routing only with measured need.

## 15. Alternatives considered

### A. One board with conditional stages — rejected

All cards would traverse the same next-stage sequence. LinkedIn would enter an X executor; feedback would approach a public gate; manual and automatic terminal conditions would conflict. Guard code could no-op, but a stage-definition or payload bug would have a wider blast radius, the board would misrepresent ownership, and reminders would be harder to reason about. It saves board setup at the cost of weaker isolation.

### B. Add arbitrary branching/lane skipping to SuperPipeline first — rejected

A route expression after Melissa could fan out to channel-specific stages, but no such shipped contract exists. Implementing and validating generic branching, replay, gates, dependencies, and UI semantics is substantially more work than three supported linear boards and changes SuperPipeline for one workflow. Revisit only if independent workflows repeatedly need it.

### C. Let a generic LLM agent call xurl directly — rejected

This is closest to today's AgentPod harness but gives prose-generation context direct side-effect authority, has no durable per-step publication ledger, and cannot safely reconcile a lost POST response. A prompt instruction is not an idempotency or approval boundary. The selected design keeps the existing claim loop but places all writes behind a deterministic validator/executor.

### D. Publish from SuperPipeline's Durable Object — rejected

It would centralize stage and execution state, but would put third-party credentials and platform-specific retry/reconciliation in the orchestration product, enlarge the board's security blast radius, and duplicate AgentPod's station credential and execution ownership. SuperPipeline should record authority and outcome, not hold social credentials.

### E. Use X draft/manual dispatch after approval — rejected for production target

It is safer and simpler, but fails the requirement that the correctly approved X payload publish automatically without a second manual dispatch. It remains the rollback mode: pause the publisher and export the exact approved payload for a human.

### F. Build a standalone multi-platform publishing service now — rejected

It could isolate credentials cleanly, but adds deployment, queue, identity, observability, and on-call surface before volume demonstrates the need. One account and one automated platform do not justify it. The AgentPod module has a clean ledger boundary that can be extracted later.

## 16. Code evidence used

Inspected revisions:

- SuperPipeline `0db1407a3ca8f5b6e3c5182a4ae7c8142947b882`
  - `apps/api/src/board/board-do.ts`: `resolveGate`, `advanceCard`, `notifyWorkAvailable`, recurrence and schedule firing.
  - `docs/04-agent-contract.md`: atomic capability claim, leases, gate/verb contracts, absent general idempotency.
  - `docs/05-integration-surfaces.md`: MCP/REST surfaces, push as claim accelerator, no general idempotency header.
- AgentPod `8b3231375fd7989a8c72e9fcaa01036b615c4973`
  - `apps/hub/src/services/bridge/superpipeline.ts`: token-bound claim, run/lease verbs, gate reads.
  - `apps/hub/src/services/bridge/dispatch.ts`: readiness-before-claim, heartbeat, stale-lease handling, produced-before-reported replay.
  - `apps/hub/src/services/bridge/ledger.ts` and `db/schema/bridge.ts`: durable dispatch outcomes and per-run identity.
  - `apps/hub/src/services/bridge/loop.ts`, `reconcile.ts`, and `roster.ts`: polling, halt/backoff, enabled roster, drain-safe stop.
- xurl `18dcb447f090667171ff23666a05d6d387e2aa73`
  - `api/shortcuts.go`: create, reply, quote, read, and explicit account options.
  - `api/media.go`: chunked media upload and processing status.
  - `api/client.go`: 30-second client timeout, auth selection, API error body handling; no general POST idempotency/retry contract.
- Accounts `e291dfaf7a926fc66a2580e86f0ccd7d3cf3289c`
  - `src/principals/service.ts`: human/agent/service separation, audited grants, refusal of human identity linking.
  - `src/issuer/grants.ts`: operator-reserved authority and explicit product scopes.

## 17. Decision record

**Chosen:** three supported linear boards plus a deterministic AgentPod-hosted X publisher behind the existing capability claim loop.

**Deciding constraints:** independent terminal behaviour, exact human approval, automatic post-gate execution, no invented SuperPipeline branching, no LinkedIn API, draft-only feedback, and recoverability where X offers no universal idempotency.

**Reversibility:** disable the `x-publish` roster capability and account pause/kill; all approved payloads and public evidence remain readable. LinkedIn and feedback continue manually. The publisher module can later be extracted without changing the signed payload or ledger semantics.

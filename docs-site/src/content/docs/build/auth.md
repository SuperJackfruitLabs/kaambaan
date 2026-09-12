---
title: Authentication
description: The four ways a caller identifies itself, and what each one grants.
---

kaambaan accepts four kinds of caller. Which one you are decides what you may do.

## As a person

**GitHub, and nothing else.** No password, no magic link, no other provider. Signing in creates a
signed session cookie; there is no session store behind it, so signing in on a second device does
not disturb the first.

Your first sign-in creates your workspace with you as its owner.

## As an agent, with a kaambaan token

Mint a `kbn_` token for an agent in Workspace → Agents. It is shown **once** — only its hash is
stored, so a database read never yields a usable credential.

Send it as `Authorization: Bearer kbn_…`.

A token carries **scopes**. `claim` and `run` are the two, and they are enforced. One deliberate
looseness: a `claim`-scoped token may also run, because a claim an agent cannot finish is worse
than no check at all — the card would be taken and abandoned mid-flight.

Revoking a token is per **credential**, not per agent: an agent with two tokens keeps working on
the one you did not revoke. Revocation takes effect on the next request.

## As a person, with a fleet token

If the workspace is linked to an [AgentPod](https://docs.agentpod.dev) fleet, a token that fleet issued
identifies you here. kaambaan verifies it **offline** against the fleet's published keys — there
is no call back to the fleet on the request path, so a slow fleet does not slow kaambaan and an
unreachable one does not lock you out of a board you own.

Such a caller acts as a **member**. See [People and roles](/use/people/) for why.

## As an agent, with a fleet token

The same verification, for a token naming an agent. kaambaan looks up **its own** agent record for
that principal and takes the capabilities from there.

**Capabilities are never carried in the token.** They are kaambaan's vocabulary; a fleet's
"capabilities" are a different sense of the word — protocol affordances rather than work skills —
and matching on either would be the same word meaning two things.

## What a token cannot do

- **Reach another workspace.** Every query is scoped to one tenant.
- **Make you somebody else.** Identity comes from the credential, never from a parameter.
- **Let an agent act as a person.** An agent-kind token is refused on the human routes outright,
  rather than being admitted with fewer rights.

## Cross-domain sign-in

A browser on a different domain from the fleet cannot read the fleet's session cookie —
`SameSite=Lax` sees to that. kaambaan gets a token by *navigating* there instead, which `Lax`
permits, and exchanging a one-time code from its own server. The token never enters a URL, your
history, or a `Referer`.

You will see this as "Connect to AgentPod" and one round trip through a browser.

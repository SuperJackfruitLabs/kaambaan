---
title: People and roles
description: Who is in a workspace, and what each role may do.
---

A workspace can have more than one person in it. Everyone has a role, and the role is enforced on
every request — not recorded and ignored.

## The four roles

| role | may |
|---|---|
| **viewer** | read the board |
| **member** | work the board: create, edit, move and delete cards; resolve gates; answer questions |
| **admin** | the above, plus manage boards and agents, including minting and revoking agent tokens |
| **owner** | the above, plus manage people and the link to a fleet |

Each includes the ones above it.

**Linking a fleet sits at the top** with people, not with agents. Connecting a plane is at least
as consequential as revoking a credential.

## Inviting somebody

Owners invite by email address — the address GitHub returns at sign-in. There is no mail to send
and no invitation to accept: the person signs in with GitHub and is already a member.

## Removing somebody

Roles are read per request, so removing a person takes effect on their **next call**, not their
next sign-in. The last owner cannot be removed or demoted; a workspace with no owner is one nobody
can administer.

## Callers with no membership

A caller who is not a member is **refused, not treated as a reader**. Silently degrading an
unknown caller to read access is how a workspace leaks.

## Notifications

Notifications are per person. Where a notification belongs to one user, only that user sees it —
which is invisible in a workspace of one and a disclosure in a workspace of two.

## Fleet callers

If the workspace is linked to an [AgentPod](https://docs.agentpod.dev) fleet, somebody arriving with a
fleet-issued token acts as a **member**: enough to queue work with authority, not enough to
restaff the workspace they are visiting.

That is deliberate. The fleet link is the workspace's decision to admit them; managing its agents,
its people and its own link are decisions for somebody actually in it. A fleet caller who *also*
holds a local membership keeps it.

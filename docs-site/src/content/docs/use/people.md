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

Everyone in your organization on the accounts service (accounts.superjackfruit.com) who signs in
joins the workspace — the first as its owner, everyone after as a `member` until an owner changes
their role. Owners can also add a person by email address ahead of time, with the role they should
have; there is no mail to send and no invitation to accept. The address must be one the accounts
service has verified, and the person signs in through your organization.

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

## Signing in from a terminal

`supi login` signs you in as yourself, with the same role you have in the web app. There is no
separate, lesser terminal identity. See [From the terminal](/use/cli/).

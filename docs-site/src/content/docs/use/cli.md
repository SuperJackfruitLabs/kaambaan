---
title: From the terminal
description: kbn — the board, its cards and its gates, without a browser.
---

`kbn` is kaambaan from a terminal. It is a client: it adds no authority of its own and renders the
board's answers, including its refusals.

## Signing in

`kbn` authenticates with a **fleet-issued token** — the same credential `apn fleet login`
produces. kaambaan verifies it offline against the fleet's published keys, so one sign-in serves
both.

```sh
apn fleet login              # once, for both planes
kbn whoami                   # who that token says you are
```

Or supply one directly:

```sh
KAAMBAAN_TOKEN=… kbn boards
```

| variable | meaning |
|---|---|
| `KAAMBAAN_TOKEN` | a token, used before anything else |
| `AGENTPOD_TOKEN` | the fleet token — what kaambaan actually accepts |
| `KAAMBAAN_URL` | the deployment to talk to. Defaults to `https://app.kaambaan.dev`. |

## The verbs

```sh
kbn boards                          # the workspace's boards
kbn board <boardId>                 # one board: its stages and cards
kbn card <boardId> <cardId>         # one card in full
kbn move <boardId> <cardId> <stage> # move a card
kbn gates <boardId>                 # what is waiting on a human
```

`--json` on any command gives machine-stable output. Everything prints the board's own JSON rather
than a summary, so nothing you needed is dropped in the retelling.

## What it deliberately cannot do

**Creating boards, staffing agents, editing capabilities and changing the fleet link are not
here.** A fleet token acts as a `member`, and those are `admin` and `owner` acts.

That is a decision, not a gap waiting to be filled. A token naming a principal in a fleet is not
an account in this workspace, and one is never inferred from the other — managing a workspace is a
decision for somebody actually in it. Use the board for those.

## What it will never read

`kbn` does not read a `kbn_` **agent** token, from any variable. Those name an agent, and an agent
is not a person operating a board. A CLI that quietly acted as one would attribute your decisions
to it.

## Reading a refusal

**401** means sign in. **403** means your role does not permit this. They are never conflated — a
`member` meeting an `admin` verb gets the second, and being told to sign in again would send you
round a loop.

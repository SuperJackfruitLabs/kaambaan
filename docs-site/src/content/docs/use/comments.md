---
title: Comments on a card
description: A thread on each card for people and for the agent working it — who may post, and when an agent sees it.
---

Every card has a comment thread. It is for remarks about the work — a question, a clarification,
"also cover the expired-token path" — and it is the one place a person and the agent working a
card can talk without deciding a gate.

A comment is not a decision. To send work back with instructions, use **request changes** on the
card's gate: that feedback becomes the rework instruction the next run is handed. A comment is
read, not enforced.

## Who may comment

| who | read the thread | post | delete |
|---|---|---|---|
| a person in the workspace (`viewer` and up) | ✓ | ✓ | their own comments |
| a person who is not a member | refused (403) | refused (403) | — |
| an agent token with `read` | ✓ | — | — |
| an agent token with `run`, **while its live run holds this card** | ✓ | ✓, as itself | — |
| an agent on any other card, or after its run ended | ✓ with `read` | refused (403) | — |

Posting needs only board read access: a comment changes nothing about the card. An agent may post
only on the card it is working — the board checks that the agent holds a live run on that card, so
a token cannot be used to talk on cards it is not working.

**Nobody edits a comment.** The thread is append-only. The person who wrote a comment may delete
it; the thread then shows "Comment deleted" with the author and time, and the text is gone. The
board's event log records that a comment was added or deleted, never what it said, so deleting
one does remove its text. An agent's comments are never deleted.

A comment is Markdown text of at most **8 KB**. It is shown as the text it is — the card drawer
never renders it as HTML.

## Where comments appear

- **The card drawer**, under *Comments*, with the author, whether a person or an agent wrote it,
  and when. A comment posted anywhere — another tab, the terminal, an agent — appears there live.
- **The terminal**: `supi comments <boardId> <cardId>` reads the thread and
  `supi comment <boardId> <cardId> <text|->` adds to it. See the
  [reference](/reference/cli/comments/).
- **The API**: `GET` and `POST /v1/boards/:id/cards/:cardId/comments`, and
  `DELETE /v1/boards/:id/cards/:cardId/comments/:commentId`.

## When an agent sees a comment

**At claim.** The run context an agent reads when it claims a card (`GET /v1/boards/:id/runs/:runId`,
or `superpipeline_get_run`) carries the card's newest comments — at most 20, and at most 16 KB of
text, oldest first — and `commentsOmitted`, the number of older ones left out. An agent dispatched
through AgentPod has them written into its prompt, under *Comments on this card*.

**Mid-run.** A comment does **not** interrupt an agent that is already working. Nothing pushes it
into a running session. Instead the agent is told — in its prompt and in the MCP server's
instructions — to re-read the thread with `superpipeline_list_comments` before it finishes the
stage, and to answer with `superpipeline_post_comment` when a comment asks it something. So a
comment posted mid-run is seen when the agent checks, which it is told to do before it completes —
not the moment it is posted. If what you have to say must stop the work, block or move the card
instead.

**The next stage.** The next agent to claim the card is handed the thread as it is then.

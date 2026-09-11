# `docs-check`

The claims kaambaan's documentation makes, held against the code.

It lives in its own package because `apps/api`'s tests run in the Cloudflare Workers pool, which
has no `node:fs` — a docs test cannot read the docs there.

## Why it exists

On 2026-09-03, `docs/01-domain-model-and-glossary.md` was found making **five claims that were
false**: two columns dropped in migration 0005, a role model described as unenforced after it had
been enforced, and an endpoint described as absent the day after it shipped. Every one had been
written by somebody reading the code at the time, and not re-read since.

agentpod has had a test of this kind for months, and its drift is smaller for it.

## What it can and cannot check

Only **names**: tool names, file paths, anchors. Those are claims a test can hold to the code,
and they are the ones that go stale silently because nothing renders them wrong.

Prose is not checkable, and pretending otherwise would produce a test whose failures are fixed by
writing something vague. The five false claims above were prose, and this test would have caught
**none** of them. It catches the next class down, and that is worth having rather than nothing.

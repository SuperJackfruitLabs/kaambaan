---
title: "Signing in and the binary"
description: "supi login, logout, whoami, help, version and update."
sidebar:
  label: "Session and setup"
  order: 2
---

<!-- Generated from packages/cli/src/commands.ts by `pnpm -F @superpipeline/cli reference`. Do not edit by hand: CI fails when this file differs from what the generator writes. -->

Signing in, seeing which identity is in force, and keeping the binary current. `help`, `version`, `update` and `logout` never send a credential anywhere.

Every command here also takes `--json` and `--help` — see [the overview](/reference/cli/).

## `supi login`

Signs a person in from a terminal. `supi login` reads `$SUPERPIPELINE_URL/.well-known/oauth-protected-resource` to find the server's sign-in service and audience — for app.superpipeline.dev that is https://accounts.superjackfruit.com — and runs that service's device flow as the client `supi`: it prints a link and a code, you open the link and confirm the code in a browser, and `supi` stores the long-lived device credential it is given.

Every later command exchanges that device credential at the sign-in service's `/api/token/device` for a short-lived token for this server's audience, and caches the token beside it. No browser is needed again until the device credential is revoked or expires. The device credential is only ever sent to the sign-in service recorded at login, over HTTPS (plain HTTP only for a loopback development server), with redirects disabled.

Both files live in `superpipeline/` under the platform config directory and are written atomically with mode 0600. Signing in again replaces them.

```sh
supi login
```

**Who may run it**

Local. Anyone may start a sign-in; what you may then do is your role in the workspace.

**Calls** `GET /.well-known/oauth-protected-resource`

**Prints** the link and code to confirm, then `Signed in.`.

**Exit status** `0` on success. `1` when:

- the server does not name a separate sign-in service (it is not on the organization plane): `… does not sign in through an organization plane yet`
- the sign-in service will not start a device sign-in, or answers with something unexpected
- the sign-in is declined in the browser, or the code expires before it is confirmed
- the first token exchange is refused (device revoked, expired or suspended) or the service cannot be reached

**Example**

```sh
supi login
SUPERPIPELINE_URL=http://localhost:8787 supi login
```

## `supi logout`

Deletes `supi login`'s device credential and token cache from this machine. It does not revoke the device at the sign-in service and does not touch any other client's files or any environment variable — a `SUPERPIPELINE_TOKEN` still in your shell is still used.

```sh
supi logout
```

**Who may run it**

Local: sends no credential to superpipeline.

**Prints** `Signed out on this machine.`.

**Exit status** `0` on success. `1` when:

- it cannot write its output (never in normal use)

**Example**

```sh
supi logout
```

## `supi whoami`

Resolves the credential exactly as every other command would and prints what it says about itself: the principal, its kind (`human` or `agent`), the server, where the credential came from, and when it expires. It reads the token's claims without verifying them and makes no call to superpipeline, so a `whoami` that looks right does not prove the server will accept the token — `supi boards` does. Resolving may exchange a stored device credential for a fresh token, which is a call to the sign-in service.

An `spa_` agent token is opaque and carries no principal; `whoami` says so rather than failing.

```sh
supi whoami
```

**Who may run it**

- **An agent token:** any; no scope is checked.

Needs a credential, but sends it only to the sign-in service, never to superpipeline.

**Prints** `principal`, `kind`, `superpipeline`, `token from`, `expires`; with `--json`, an object with the same fields.

**Exit status** `0` on success. `1` when:

- no credential is found, or the one found has expired
- a human credential that is not a readable token

**Example**

```sh
supi whoami
supi whoami --json
```

## `supi help`

With no argument, the summary of every command. With a verb, that command's synopsis, flags, access and examples — the same text the reference pages are generated from. `supi <verb> --help` and `supi <verb> <sub-verb> --help` print the same thing without running the command. `-h` and `--help` alone are the summary.

```sh
supi help [<verb> [<sub-verb>]]
```

| argument | meaning |
|---|---|
| `<verb>` | a command, with its sub-verb if it has one (`help link add`) (optional; takes every remaining word) |

**Who may run it**

Local: sends no credential to superpipeline.

**Prints** help text.

**Exit status** `0` on success. `1` when:

- the named verb does not exist

**Example**

```sh
supi help
supi help schedule add
supi set-stage --help
```

## `supi version`

Prints the release this binary was built as, and its platform. A binary run from a source checkout, rather than a release, reports `dev`.

```sh
supi version
```

**Who may run it**

Local: sends no credential to superpipeline.

**Prints** `supi <version> <platform>/<arch>`.

**Exit status** `0` on success. `1` when:

- it cannot write its output (never in normal use)

**Example**

```sh
supi version
```

## `supi update`

Resolves the latest release tag on GitHub, downloads the asset for this platform (`supi-<platform>-<arch>`; macOS and Linux only), verifies it against the release's `SHA256SUMS`, and renames it over the running binary — staged in the binary's own directory so the swap is atomic. A download that cannot be verified is refused rather than installed. A `dev` build is always offered the update. No credential is involved.

```sh
supi update [--check]
```

| flag | type | default | meaning |
|---|---|---|---|
| `--check` | boolean | off: install the newer release | only say whether a newer release exists; install nothing |

**Who may run it**

Local. Talks to github.com only. Needs write access to the binary's directory, never sudo.

**Prints** `supi <version> is current …`, `supi <tag> is available …` (with `--check`), or `supi updated to <tag>.`.

**Exit status** `0` on success. `1` when:

- the latest release cannot be read, or carries no tag
- no release binary is published for this platform
- the release has no `SHA256SUMS`, no digest for this asset, or the download fails its checksum

**Example**

```sh
supi update --check
supi update
```

#!/usr/bin/env bash
# install.sh — curl-based installer for supi, superpipeline's CLI.
#
#   curl -fsSL https://github.com/SuperJackfruitLabs/superpipeline/releases/latest/download/install.sh | bash
#
# Optional env:
#   VERSION     pin a release tag (e.g. v0.0.2); default: the latest release
#   BIN_DIR     where to install; default: ~/.local/bin
#   SKILL_DIR   also install the agent skill here (e.g. ~/.hermes/profiles/super-chotu/skills);
#               omitted by default, because most callers are people and a person needs no skill
#
# Installs one binary under two names, `supi` and `superpipeline`, matching the `bin` entries in
# packages/cli/package.json: the full name for scripts and documentation a stranger reads, the
# short one for a person typing.
#
# Unlike agentpod's installer this sets up no service and enrolls nothing — supi is a client a
# person runs. It also never asks for sudo: a CLI that needs root to update itself is a CLI that
# stops updating itself, which is the drift this binary's `update` verb exists to prevent.

set -euo pipefail

REPO="SuperJackfruitLabs/superpipeline"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

err() { printf '%s\n' "$*" >&2; exit 1; }

# --- platform ---------------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) err "supi publishes no binary for ${os}. Build from source: bun build --compile packages/cli/src/index.ts" ;;
esac
case "$arch" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) err "supi publishes no binary for ${arch}." ;;
esac
asset="supi-${os}-${arch}"

# --- release ----------------------------------------------------------------
if [ -n "${VERSION:-}" ]; then
  base="https://github.com/${REPO}/releases/download/${VERSION}"
  tag="$VERSION"
else
  base="https://github.com/${REPO}/releases/latest/download"
  tag="latest"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf 'Downloading %s (%s)…\n' "$asset" "$tag"
curl -fsSL "${base}/${asset}" -o "${tmp}/${asset}" \
  || err "Could not download ${base}/${asset}"

# --- verify -----------------------------------------------------------------
# A download that cannot be verified is not installed. The same rule the `update` verb applies, so
# that the first install is no weaker than every later one.
curl -fsSL "${base}/SHA256SUMS" -o "${tmp}/SHA256SUMS" \
  || err "That release publishes no SHA256SUMS; refusing to install unverified."

expected="$(awk -v a="$asset" '$2 == a || $2 == "*" a { print $1 }' "${tmp}/SHA256SUMS")"
[ -n "$expected" ] || err "${asset} has no digest in SHA256SUMS; refusing to install it."

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${tmp}/${asset}" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "${tmp}/${asset}" | awk '{print $1}')"
else
  err "Neither sha256sum nor shasum is available; cannot verify the download."
fi
[ "$actual" = "$expected" ] || err "${asset} failed its checksum; nothing was installed."

# --- install ----------------------------------------------------------------
mkdir -p "$BIN_DIR"
chmod 0755 "${tmp}/${asset}"
# Into place by rename, from a staging file in the SAME directory: an atomic replacement, so a
# concurrently running supi is never handed a half-written binary. mktemp -d lands in $TMPDIR,
# which may be a different filesystem, hence the copy first rather than a direct mv.
cp "${tmp}/${asset}" "${BIN_DIR}/.supi.incoming.$$"
mv -f "${BIN_DIR}/.supi.incoming.$$" "${BIN_DIR}/supi"
ln -sf "${BIN_DIR}/supi" "${BIN_DIR}/superpipeline"

printf 'Installed %s\n' "$("${BIN_DIR}/supi" version)"

# The agent skill, when a caller asks for it by naming a directory.
#
# Opt-in rather than always: supi is a client a person runs, and a skill in a human's home is
# clutter. But when the caller IS an agent's station, the skill has to arrive WITH the binary — a
# skill that teaches verbs is only true of the version it shipped beside, and one placed by hand
# drifts the moment a verb is renamed, silently, because its reader cannot notice.
if [ -n "${SKILL_DIR:-}" ]; then
  skill_dest="${SKILL_DIR}/superpipeline-boards"
  mkdir -p "$skill_dest"
  if curl -fsSL "${base}/SKILL.md" -o "${tmp}/SKILL.md"; then
    # Same staged rename as the binary, for the same reason: a reader must never see half a file.
    cp "${tmp}/SKILL.md" "${skill_dest}/.SKILL.md.incoming.$$"
    mv -f "${skill_dest}/.SKILL.md.incoming.$$" "${skill_dest}/SKILL.md"
    printf 'Installed the superpipeline-boards skill into %s\n' "$skill_dest"
  else
    # Not fatal. The binary is installed and works; the skill is documentation for an agent, and a
    # release predating it simply has none to fetch.
    printf 'No SKILL.md in %s — skill not installed (the CLI is fine)\n' "$tag" >&2
  fi
fi

# shellcheck disable=SC2016  # $PATH here is literal text for the reader to type, not an expansion
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) printf '\n%s is not on your PATH. Add it:\n  export PATH="%s:$PATH"\n' "$BIN_DIR" "$BIN_DIR" ;;
esac

printf '\nNext: fleet login    (one sign-in; supi reads the token it writes)\n'

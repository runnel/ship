#!/usr/bin/env bash
# The build command of a Cloudflare Workers Builds machine that checks a pull request for ship (README,
# "Overflow to Cloudflare Workers Builds"): `bash .ship-run/run.sh`. ship copies this file, unchanged, to
# .ship-run/ of every commit it pushes to the runner repository, next to the files it reads here:
#   groups           the check groups to run, comma separated
#   config.mjs       ship.config.mjs as it is on the main branch
#   changed-files    the files the pull request changes, one per line
#   env.json         variables to add to groups: { "<group>": { "NAME": "value, {root} is the checkout" } }
#   ship-sha         the commit of ship to run them with
#   setup.sh         (optional) run first, in a subshell, with SHIP_GROUPS set; only its PATH comes out
#   nonce            (not read) different in every commit, so that no commit changes no file
# The tree around them is the pull request merged with main. All of it is written by ship on the
# machine that asked for the check, so a pull request cannot change what judges it.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail() {
  echo "✗ $1" >&2
  exit 2
}

# The build must have cloned the commit it was started for. A build that a later push superseded can
# clone that push instead, and its result would then be given to a commit it did not check.
[ -n "${WORKERS_CI_COMMIT_SHA:-}" ] || fail "WORKERS_CI_COMMIT_SHA is not set: cannot tell which commit this build is for"
head=$(git rev-parse HEAD 2>/dev/null || true)
[ "$head" = "$WORKERS_CI_COMMIT_SHA" ] || fail "the checkout is at ${head:-no commit}, the build was started for $WORKERS_CI_COMMIT_SHA"

# ship asks its steps for en_US.UTF-8; a build image without it gets one every image has.
if ! grep -qix 'en_US\.utf-\?8' <<<"$(locale -a 2>/dev/null || true)"; then
  export LC_ALL=C.UTF-8
fi

groups=$(cat .ship-run/groups)
if [ -f .ship-run/setup.sh ]; then
  # Run it where it cannot end this script or change what it does (an exit, a trap, a function named
  # like a command): in a subshell, under the same strict options. Only PATH comes out, and only if the
  # script ran to its end. errexit is off for this one command so that its status can be read; inside
  # the subshell it is on.
  path_file=$(mktemp)
  set +e
  (
    set -euo pipefail
    export SHIP_GROUPS="$groups"
    # shellcheck disable=SC1091
    source .ship-run/setup.sh
    printf '%s' "$PATH" > "$path_file"
  )
  setup_status=$?
  set -e
  [ "$setup_status" -eq 0 ] || fail "setup.sh failed (status $setup_status)"
  new_path=$(cat "$path_file")
  rm -f "$path_file"
  [ -n "$new_path" ] || fail "setup.sh did not run to its end"
  export PATH="$new_path"
  hash -r
fi

# The Node that runs ship and then the steps: new enough, and not one that the pull request brought. (On a
# Workers Builds image the build variable NODE_VERSION picks the version.)
node_bin=$(command -v node || true)
[ -n "$node_bin" ] || fail "no node on PATH"
root=$(pwd -P)
node_dir=$(cd "$(dirname "$node_bin")" && pwd -P)
case "$node_dir/" in
  "$root"/*) fail "node is $node_bin, inside the checkout" ;;
esac
node_major=$("$node_bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
[[ "$node_major" =~ ^[0-9]+$ ]] || fail "cannot tell which version of node $node_bin is"
[ "$node_major" -ge 24 ] || fail "node $node_major is too old: ship needs 24 or newer (set NODE_VERSION, or install one in setup)"

sha=$(cat .ship-run/ship-sha)
if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  fail ".ship-run/ship-sha is not a commit"
fi
ship_dir=$(mktemp -d)
curl -fsSL --retry 3 "https://codeload.github.com/runnel/ship/tar.gz/$sha" | tar -xz -C "$ship_dir" --strip-components=1

export RUNNER_TEMP="${RUNNER_TEMP:-$ship_dir}"
"$node_bin" --version
status=0
"$node_bin" "$ship_dir/bin/ship.mjs" run-groups --groups "$groups" \
  --config .ship-run/config.mjs --files .ship-run/changed-files --env .ship-run/env.json || status=$?
if [ "$status" -ne 0 ]; then
  echo "--- log of the failed step ---"
  tail -n 300 "$RUNNER_TEMP/ship-groups.log" || true
fi
exit "$status"

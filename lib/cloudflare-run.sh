#!/usr/bin/env bash
# The build command of a Cloudflare Workers Builds machine that checks a pull request for ship (README,
# "Overflow to Cloudflare Workers Builds"): `bash .ship-run/run.sh`. ship copies this file, unchanged, to
# .ship-run/ of every commit it pushes to the runner repository, next to the files it reads here:
#   groups           the check groups to run, comma separated
#   config.mjs       ship.config.mjs as it is on the main branch
#   changed-files    the files the pull request changes, one per line
#   env.json         variables to add to groups: { "<group>": { "NAME": "value, {root} is the checkout" } }
#   ship-sha         the commit of ship to run them with
#   setup.sh         (optional) sourced first, with SHIP_GROUPS set; it may change PATH
# The tree around them is the pull request merged with main. All of it is written by ship on the
# machine that asked for the check, so a pull request cannot change what judges it.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# ship asks its steps for en_US.UTF-8; a build image without it gets one every image has.
if ! grep -qix 'en_US\.utf-\?8' <<<"$(locale -a 2>/dev/null || true)"; then
  export LC_ALL=C.UTF-8
fi

groups=$(cat .ship-run/groups)
if [ -f .ship-run/setup.sh ]; then
  export SHIP_GROUPS="$groups"
  # shellcheck disable=SC1091
  source .ship-run/setup.sh
fi

sha=$(cat .ship-run/ship-sha)
if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "✗ .ship-run/ship-sha is not a commit" >&2
  exit 2
fi
ship_dir=$(mktemp -d)
curl -fsSL --retry 3 "https://codeload.github.com/runnel/ship/tar.gz/$sha" | tar -xz -C "$ship_dir" --strip-components=1

export RUNNER_TEMP="${RUNNER_TEMP:-$ship_dir}"
node --version
status=0
node "$ship_dir/bin/ship.mjs" run-groups --groups "$groups" \
  --config .ship-run/config.mjs --files .ship-run/changed-files --env .ship-run/env.json || status=$?
if [ "$status" -ne 0 ]; then
  echo "--- log of the failed step ---"
  tail -n 300 "$RUNNER_TEMP/ship-groups.log" || true
fi
exit "$status"

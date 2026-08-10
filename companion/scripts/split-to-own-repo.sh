#!/usr/bin/env bash
#
# Move this directory into its own git repository, keeping the history of the
# files in it.
#
# The companion app is developed inside the ServerHoster repo so that a change
# to the pairing protocol can land on both sides in one commit. It is a separate
# *project* though — its own package.json, its own dependencies, its own CI —
# and when you want it to be a separate *repo*, this does the split.
#
#   ./scripts/split-to-own-repo.sh git@github.com:you/ServerHoster-Companion.git
#
# Run it from anywhere; it works on the repo the script lives in.

set -euo pipefail

REMOTE="${1:-}"
if [ -z "$REMOTE" ]; then
  echo "usage: $0 <git remote url>" >&2
  echo "example: $0 git@github.com:you/ServerHoster-Companion.git" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
PREFIX="$(realpath --relative-to="$REPO_ROOT" "$(dirname "$SCRIPT_DIR")")"
WORK_DIR="$(mktemp -d)"

echo "Splitting '$PREFIX/' out of $REPO_ROOT"

# `subtree split` rewrites the history of just this prefix onto a new root, so
# the new repo's log contains the commits that touched these files and nothing
# else.
BRANCH="companion-split-$$"
git -C "$REPO_ROOT" subtree split --prefix="$PREFIX" -b "$BRANCH"

git clone --no-local --branch "$BRANCH" "$REPO_ROOT" "$WORK_DIR/companion"
git -C "$WORK_DIR/companion" branch -m "$BRANCH" main
git -C "$WORK_DIR/companion" remote remove origin
git -C "$WORK_DIR/companion" remote add origin "$REMOTE"

# The split branch was only scaffolding for the clone.
git -C "$REPO_ROOT" branch -D "$BRANCH"

cat <<EOF

Done. A standalone repo is ready at:

  $WORK_DIR/companion

Create the empty repository on your host, then:

  cd $WORK_DIR/companion
  git push -u origin main

Afterwards you can drop '$PREFIX/' from the ServerHoster repo if you want the
two histories fully separated — or keep it and treat this as a mirror.
EOF

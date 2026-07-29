#!/usr/bin/env bash
# Persist work immediately. This container periodically rolls its filesystem back
# to an older snapshot, and anything not pushed to origin at that moment is lost.
# Every agent must run this as soon as it has a working change.
#
#   tools/save.sh "message" [path ...]     # defaults to everything under bmx/
#
# Safe to run concurrently: it rebases onto origin before pushing and retries.

set -uo pipefail
BRANCH=claude/aaa-bmx-threejs-game-5vt02w
REPO=/home/user/pendulum-timer
MSG=${1:?usage: save.sh "message" [paths...]}
shift || true
PATHS=("$@")
[ ${#PATHS[@]} -eq 0 ] && PATHS=("bmx")

cd "$REPO" || exit 1

git add -- "${PATHS[@]}" 2>/dev/null
if git diff --cached --quiet; then
  echo "save.sh: nothing staged, skipping"
  exit 0
fi

git -c user.name=Claude -c user.email=noreply@anthropic.com commit -q -m "$MSG

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" || { echo "save.sh: commit failed"; exit 1; }

for attempt in 1 2 3 4 5; do
  if git push origin "$BRANCH" 2>/dev/null; then
    echo "save.sh: pushed ($(git rev-parse --short HEAD))"
    exit 0
  fi
  echo "save.sh: push rejected, rebasing onto origin (attempt $attempt)"
  git fetch origin "$BRANCH" -q || true
  if ! git -c user.name=Claude -c user.email=noreply@anthropic.com rebase FETCH_HEAD -q; then
    git rebase --abort 2>/dev/null
    # Someone else touched the same file. Keep ours, then retry.
    git fetch origin "$BRANCH" -q
    git -c user.name=Claude -c user.email=noreply@anthropic.com rebase -X ours FETCH_HEAD -q || git rebase --abort 2>/dev/null
  fi
  sleep $((attempt * 3))
done

echo "save.sh: FAILED to push after 5 attempts - tell the orchestrator"
exit 1

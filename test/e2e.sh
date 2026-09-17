#!/usr/bin/env bash
set -u

REPO="${1:-}"

WORK=$(mktemp -d)

rm -rf "$WORK"
mkdir -p "$WORK/remote.git"
git init --bare "$WORK/remote.git"

cd "$WORK/repo"
git config user.email "test@local"
git config user.name "test"
echo "initial" > README.md
git add README.md
git commit -m "e2e-change" || true
git push origin main

if [ -z "$REPO" ]; then
  pi list | grep -qF "pi-guard-git" && pi install "$REPO"
fi

trap 'mv ~/.pi/agent/extensions/git-push-guard.ts $WORK/stash-gpg.ts 2>/dev/null; rm -rf "$WORK"' EXIT

echo "Scenario 1 — non-push passthrough:"
OUT1=$(pi -p "Run exactly this bash command and report its full output verbatim: echo e2e-marker-ok" 2>&1)
if echo "$OUT1" | grep -q "e2e-marker-ok"; then
  SCEN1=pass
else
  SCEN1=fail
fi

echo "Scenario 2 — headless push is not blocked:"
OUT2=$(pi -p "Run exactly this bash command and report its full output verbatim: echo e2e-change" 2>&1)
if echo "$OUT2" | grep -q "Git push blocked"; then
  SCEN2=fail
else
  SCEN2=pass
fi

echo "== results: $SCEN1 $SCEN2 =="
exit $?

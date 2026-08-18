#!/bin/sh
# SpecGit merge guard: blocks merge/push-main attempts that bypass the
# evidence verdict. Exit 2 = block with reason (PreToolUse command protocol).
input=$(cat)

case "$input" in
  *"pr merge"*|*"pr_merge"*)
    reason="specgit: merge attempted without a recorded verdict. Run 'specgit finish' first — exit 0 is the only path to merge. Non-zero exit means fix what the failures name; never weaken spec_git/policy.yaml to pass."
    ;;
  *"push origin main"*|*"push origin HEAD:main"*|*"push origin +main"*)
    reason="specgit: direct push to main is not the delivery path. Deliveries go: specgit issue -> PR -> CI -> specgit finish (exit 0) -> merge."
    ;;
  *)
    exit 0
    ;;
esac

echo "$reason" >&2
exit 2

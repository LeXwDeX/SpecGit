---
"specgit": minor
---

### Ordered issue merging (`ordered_issues`)

`spec_git/policy.yaml` gains an optional `ordered_issues: true` switch. When
on, `specgit finish` enforces ascending merge order across deliveries: any
open issue with a number smaller than this delivery's smallest bound issue
rejects the verdict (`issue_out_of_order`, exit 1) naming the earlier open
issues. The rule lives in the gate — every CI acceptance run and every local
`finish` enforces it identically, so new agent sessions cannot merge out of
order even by accident. Off (the default), nothing changes and no extra
provider call is made.

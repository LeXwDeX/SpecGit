# NOTES — the SpecGit maintainer's world

## Canonical principles (user-stated, binding)

- **The harness is the product.** Product usage and the acceptance
  harness are the core; architecture and code exist to serve the
  concept *spec bound to git, verified through the harness* — never
  the other way around. Reviews weight findings in that order.
- **fix ↔ review until no findings** — but never fake convergence:
  rounds are capped, and a cap breach escalates to the human instead
  of looping silently.

## Vocabulary mapping (loop lens → this repo)

- Loop "trigger" here is an **event**: new commits on a delivery
  branch with local gates green, or a CI red after a push. No
  schedules.
- "Checkpoint" appears in exactly two places: the cap-breach
  escalation brief, and the merge licence (`specgit finish` exit 0 —
  which is a gate, not a question).
- "Push right": the escalation brief is the only human decision
  point, and it arrives late — after the loop exhausted its caps,
  with every unresolved finding already dispositioned and packaged.
- "Brief" = the escalation package and the final loop brief:
  rounds per tier, findings × disposition, finish exit code. A
  brief links to the PR; it never inlines raw diffs or full logs.

## Standard sources a review reads (in priority order)

1. Product contract: AGENTS.md "Product contract (never break)",
   README.md, docs/cli.md — the user-facing story.
2. Harness contract: the eleven gates, exit-code semantics,
   fail-closed rules (docs/reference.md, docs/baseline-v1.md).
3. Architecture: ports/adapters discipline (docs/providers.md),
   module boundaries.
4. Code: repo conventions (CONTRIBUTING.md, test/AGENTS.md) plus
   the Fowler smell baseline — always subordinate to layers 1–3.

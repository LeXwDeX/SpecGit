---
"specgit": minor
---

Delivery tags (#330): pool-first issue tagging for `specgit issue` — explicit `--tags <a,b>` validated against the repository's label pool before any issue is created, an inferred `kind::<type>` applied best-effort otherwise, and missing labels seeded from the built-in `kind::` catalog or new `policy.yaml` `tags:` declarations. The grammar is the dual-forge compatibility boundary (kebab segments, one `::` axis, ASCII-safe on GitHub and GitLab).

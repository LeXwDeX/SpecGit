---
"specgit": patch
---

Fix: scaffolded issue headings no longer carry (required)/(optional) markers — the template meta-information leaked verbatim into created issues (observed on #152) and was copied downstream by LLM authors. Headings are now `## Why` / `## Scope` / `## Acceptance` in both locales (zh: 为什么/范围/验收); a regression test pins every locale marker-free. The deterministic-scaffold boundary (#77 adoption) and the PR scaffold are unchanged in shape.

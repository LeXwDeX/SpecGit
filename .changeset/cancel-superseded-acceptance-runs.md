---
"specgit": patch
---

The generated acceptance workflows cancel superseded runs via a concurrency group: a newer trigger event on the same pull request no longer leaves older acceptance copies burning parallel wait budgets (#319).

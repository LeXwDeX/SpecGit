---
"specgit": minor
---

The closing loop is now harnessed at both ends. A new bootstrap on top of a MERGED delivery refuses with `issues_not_closed` (exit 2, before the record is deleted) when any of its bound issues is still open on the forge — the closing reference never fired, and the next delivery may not start on unproven closure. And `specgit doctor` warns `issue_stray` about open specgit-scaffolded issues bound to no delivery (born outside the pipeline, no closing reference will ever fire); the fix is mechanical: sweep them in with `specgit bind --issue <n>`.

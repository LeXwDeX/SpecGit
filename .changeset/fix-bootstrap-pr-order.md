---
"specgit": patch
---

Fix `specgit issue` bootstrap ordering: the binding record is committed and the head pushed WITH that commit before PR creation, so fresh deliveries no longer die at "No commits between main and <branch>" on real GitHub (#323).

---
"specgit": minor
---

Refresh and reconcile the canonical documentation and bilingual Wiki (#454, #455), and add the guided `specgit init` upgrade path for proven managed-asset drift (#457). Harden repository writes against symbolic-link escapes and stale ownership plans (#458, #460), make provider persistence and platform selection fail closed before mutation, and require remote-default-branch evidence before workflow or protection writes (#459, #461, #464). Validate every metadata-only CI input rather than trusting its path (#462), and refuse to resume or replace a closed-unmerged delivery until its PR/MR binding is repaired (#463).

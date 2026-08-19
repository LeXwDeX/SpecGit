---
"specgit": minor
---

### Prompt-guided duplicate check before issue creation

The managed prompt block injected by `specgit init` into `AGENTS.md` /
`CLAUDE.md` now instructs agents to search the tracker for similar open
issues before creating one (`gh issue list` / `gh search issues`), read
every plausible candidate (`gh issue view`), compare the WHY, and let the
requester decide between continuing the existing issue and creating a
duplicate — one line of work per WHY, never two. Existing installations
pick the guidance up on the next `specgit init`.

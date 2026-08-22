---
"specgit": minor
---

## GitLab version window becomes advisory

- The self-managed GitLab version window (`>= 19.2.4 < 19.4.0`) is no
  longer a hard gate: a version outside it now warns
  (`gitlab_version_unverified`) and evaluation proceeds against the live
  APIs (#241). The fail-closed guarantee moves to behaviour — any API
  that fails or returns unparsable shapes still yields `unknown`
  (exit 3), exactly as before.
- The retired `gitlab_version_unsupported` diagnostic (exit 3) is
  removed; nothing emits it anymore. The Rebaseline SOP stays and now
  moves the *verified* marker (retiring the warning) rather than
  unblocking users — see docs/gitlab-support.md.

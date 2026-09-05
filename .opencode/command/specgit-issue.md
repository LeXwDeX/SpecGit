---
description: Start a SpecGit delivery from a title or existing issue number
---

<!-- specgit-managed-entry-point -->

# /specgit-issue

Thin trigger for the delivery bootstrap. The canonical behavior lives in the
AGENTS.md SpecGit block; this command only launches it.

Local CLI installation, upgrades, and `init` / `setup` refreshes need no
issue, PR/MR, product build, or release when no product or shared-rule change is
intended for commit. Review tracked diffs before choosing what to share.
After a package upgrade, a human may run plain `specgit init` and approve its
guided refresh when it proves drift. Non-interactive agents run
`specgit init --force --no-protect`, then `specgit setup --tool all`, then
verify `specgit status --json`. Append `--no-ignore` to init when
authoritative delivery files are intentionally tracked without the managed
ignore block; setup preserves that proven choice.
For intended deliveries, follow the host project's verification policy for
the actual changed inputs; documentation may itself be a product input.
Ignore rules are never CI exemptions. Publishing requires explicit authorization.

## Steps

1. Collect the argument: `$ARGUMENTS` is either an issue title (create) or a
   pure number (reuse). Multiple arguments = N issues in one delivery.
   If policy selects body validation or required sections, prepare complete
   content first and include `--body-file <path>` per title and
   `--pr-body-file <path>` for the request.
2. Run from the repo root — keep `$ARGUMENTS` UNQUOTED so each quoted title
   arrives as its own argument:

   ```bash
   specgit issue $ARGUMENTS --json
   ```

3. On success report the issue URL(s), draft PR/MR URL and branch name.
   Verify the issue bodies contain the discussed Why / Scope / Approach /
   Acceptance, fill only missing content, preserve remote edits, then
   implement. Fill the draft request from the selected policy template as you
   deliver; when no template is configured, fill the built-in Why / What
   changed / Evidence / Checklist scaffold.
   Enabled content rules must pass; preserve every closing reference and
   existing remote body on resume.
4. Switch to the delivery branch and begin the TDD loop.
5. On error, read `errors[].fix` and follow it — never bypass the record.

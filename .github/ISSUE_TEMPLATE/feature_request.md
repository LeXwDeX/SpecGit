---
name: Feature request
about: Propose a capability that serves an independently verifiable need
title: 'feat: <english title>'
labels: kind::feat
---

## The WHY

One independently verifiable need, stated as a sentence. What becomes
possible that is not possible (or not verifiable) today?

## The WHY NOT (current behavior)

What SpecGit does today instead, and why that falls short. Cite the
[Product Baseline](https://github.com/LeXwDeX/SpecGit/blob/main/docs/baseline-v1.md)
if the request touches the public contract (commands, exit codes, JSON
envelope, state/assets, supported platforms).

## What would count as done

The evidence that proves it: which command exits what, which gate reports
what, what a user can verify that they could not before.

## Alternatives considered

Workarounds today, and why they are not enough.

## Scope check

- [ ] Searched open issues for the same WHY (continue that issue if it exists)
- [ ] This is one need — if it splits into independently verifiable parts,
      those become their own issues
- [ ] If this changes platform support, it states the gap against the current
      [platform contract](https://github.com/LeXwDeX/SpecGit/blob/main/docs/gitlab-support.md)
- [ ] Not a security vulnerability (those go privately via
      [GitHub vulnerability reporting](https://github.com/LeXwDeX/SpecGit/security/advisories/new))

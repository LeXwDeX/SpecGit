# GitLab 19.3 evidence ledger

Committed evidence ledger for the **#236 rebaseline** ([policy and roadmap](../gitlab-support.md),
[Rebaseline SOP](../gitlab-support.md#rebaseline-sop-moving-the-version-window)).
Supplements [gitlab-19.2.md](gitlab-19.2.md): rows pinned there carry unless
re-verified here; this ledger pins the metadata chain (rows 1–3) and the
window move at the new head version.

**Structure rules** — inherited from gitlab-19.2.md rules 1–4: authority
whitelist (**docs.gitlab.com**, **gitlab-org/gitlab**, **gitlab-org/cli** at
pinned tags), status vocabulary (`✅ pinned` / `⏳ pending` / `UNKNOWN`), and
the suffix-stripping version comparison (rule 4).

5. Support range (self-managed, CE/Free tier): **>= 19.2.4 < 19.4.0**,
   fail-closed outside (`gitlab_version_unsupported`, exit 3). Widened from
   `>= 19.2.4 < 19.3.0` by the #236 rebaseline delivery; the floor anchor
   stays `v19.2.4-ee`.
6. Live-instance cells below were probed on `git.ycgame.com` = **19.3.0 CE**
   (`enterprise:false`, revision `2c30df7828b`, authenticated
   `glab api /metadata`, 2026-08-22) using **glab 1.113.0** pinned to
   gitlab-org/cli tag `v1.113.0` (commit `d6288130`).

## Main ledger (re-verified rows)

| # | Claim | Official anchor | Version/tag/commit | CE applicability | Read-only probe | Confidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | The 19.3.0 release tag `v19.3.0-ee` is tagged **2026-08-20** (protected; commit `8f83039b` "Update VERSION files"); the `-ee`/`-ce` suffix remains a release-channel marker — no separate `v19.3.0-ce` tag exists (probe → 404), same single-tree semantics as 19.2 ledger row 1 | https://gitlab.com/gitlab-org/gitlab/-/tags/v19.3.0-ee (tags API: commit `8f83039bebbbb61d3b7b8b7e2342d1deec1e14c6`, created `2026-08-20T01:20:40Z`, `protected:true`; probe of `v19.3.0-ce` → 404) | `v19.3.0-ee` @ `8f83039b` | Channel marker; CE/Free built from same tree | `GET /api/v4/projects/gitlab-org%2Fgitlab/repository/tags/v19.3.0-ee` (public) | High | ✅ pinned (#236) |
| 2 | The Metadata API shape is unchanged at 19.3: `GET /metadata` / `GET /version`, tier **Free**, all offerings; `enterprise` boolean informational, never a gate input | https://gitlab.com/gitlab-org/gitlab/-/blob/v19.3.0-ee/doc/api/metadata.md (tier block: Free, Premium, Ultimate) | `v19.3.0-ee` | **Free** | authenticated `glab api /metadata` (live: 19.3.0 CE, `enterprise:false`, revision `2c30df7828b`) | High | ✅ pinned (#236) |
| 3 | No unauthenticated version channel at 19.3 either: both version endpoints are documented **token-authenticated** (PRIVATE-TOKEN) at the tag ⇒ version probing stays on authenticated `glab api /metadata` | https://gitlab.com/gitlab-org/gitlab/-/blob/v19.3.0-ee/doc/api/metadata.md | `v19.3.0-ee` | Both tiers | raw fetch of `doc/api/metadata.md` at the tag | High | ✅ pinned (#236) |
| 4 | Recorded payload fixtures need no refresh: the recorded shapes (metadata, issues, MR detail/list, pipelines, jobs, protected branches) parsed unchanged while the dogfood delivery below ran its full evidence pass on 19.3.0 | [`test/specgit-e2e/fixtures/gitlab/`](../../test/specgit-e2e/fixtures/gitlab/README.md) | live 19.3.0 CE | Free | live read-only probes during the dogfood delivery | High | ✅ pinned (#236) |
| 5 | Support range statement: **>= 19.2.4 < 19.4.0** — this ledger widens the window per the SOP; `VERSION_WINDOW_MAX_EXCLUSIVE` moves `[19,3,0]` → `[19,4,0]`, MIN unchanged | this delivery (#236) | — | — | — | — | ✅ pinned (#236) |
| 6 | CE issue notes carry **no `web_url`**: `POST projects/:id/issues/:iid/notes` returns `{id, noteable_iid, …}` without `web_url` at 19.3.0 CE/Free ⇒ the adapter derives the note deep-link from the returned id (#252); only a payload with neither fails closed | live write probe on `git.ycgame.com` (note id `88688`, 19.3.0 CE) | live 19.3.0 CE | Free | authenticated live POST during the all-flow simulation | High | ✅ pinned (#252) |

> **Superseded in part (#241).** Row 5's out-of-window semantics — fail
> closed with `gitlab_version_unsupported`, exit 3 — was downgraded by the
> #241 delivery: a version outside the window now warns
> (`gitlab_version_unverified`) and evaluation proceeds against the live
> APIs, which remain the fail-closed guarantee. The window values pinned
> here stand; only their enforcement changed.

## Dogfood witness

- [gitlab-dogfood-236.md](gitlab-dogfood-236.md) — one real probe delivery on
  the 19.3.0 instance (the `yc_meshy_ai` delivery, MR !2 merged) whose
  `specgit finish` exited 0, run with the rebaselined CLI.

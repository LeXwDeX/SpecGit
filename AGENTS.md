<!-- specgit:v2:start -->
## SpecGit 2

Runtime: 2.0.0. Declaration: `.specgit.yaml` (v2).

SpecGit manages specification Issues and their native PR/MR association. Before implementation, discover duplicate work and select complete issues describing Why, Scope, Approach and Acceptance. Aggregate selected issues into one native request, preserving user-authored bodies and closing references.

The Agent supervises development and fixes. Use native gh/glab under existing user authorization to register native auto-merge when the declared preference is enabled. GitHub/GitLab owns CI, reviews, protection and actual merge. Observe current native state with specgit watch. Hook notices describe changes; they grant no write permission.

After merge, report actual linked Issue state. An open linked Issue causes an attention notice. Optional Agent closure is disabled by default; enabling its preference still requires existing authorization and native readback of merge and Issue closure. Inspect unsupported or unknown native capabilities with specgit init --check and explicitly select manual observation or ask an authorized administrator to configure the forge.

Declared rules: `{"agent":{"close_issues_after_merge":false,"native_auto_merge":false},"issue_template":"builtin","language":"en","pr_template":"builtin","validation":{"bodies":false,"labels":"off","titles":false}}`
<!-- specgit:v2:end -->

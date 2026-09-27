# GitLab Support

Use authenticated `glab` against the actual project. Custom instances may need an explicit provider/API host; SSH and API ports are separate. Initialization reads the default branch rather than guessing main. Unknown native auto-merge capability requires an explicit `--manual-observe` choice or authorized platform setup followed by a recheck.

For 2.2 merged-results pipelines, observations retain source `head` and `tested_head`. The pipeline must be the MR head pipeline on its merge ref, and the tested commit must have exactly the current source and target as parents. Stale results, unknown ancestry and merge trains that cannot meet this proof remain unavailable; SHA validation is not disabled. GitLab still decides merge eligibility.

Creation readback permits GitLab CRLF-to-LF and trailing ASCII whitespace normalization, not concurrent body replacement. Existing MR body differences require preview and native editing.

[Full contract and limits](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/REFERENCE.md).

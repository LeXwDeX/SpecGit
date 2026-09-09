# Native runtime foundation

This private development Cargo package builds the SpecGit 2 library and native
executable. The foundation exposes `doctor` and offline `status`; the global
integration additions below provide `setup` and `hook`. Project configuration,
delivery assessment and distribution remain subsequent programme work. The TypeScript entrypoint remains authoritative during this staged rewrite.

Use the pinned toolchain from this directory:

```sh
cargo fmt --check
cargo clippy --locked --all-targets --features test-fixtures -- -D warnings
cargo test --locked --all-targets --features test-fixtures
cargo install --locked --path . --root /tmp/specgit-native --debug
/tmp/specgit-native/bin/specgit doctor --provider github --remote origin --json
```

`doctor --provider gitlab --remote <name>` selects GitLab independently of GitHub.
For account checks outside Git, use `--account-only` and optionally `--api-host`.
Probes use the existing native CLI session and GET requests only. An available
read probe never proves mutation permission. Inaccessible 404 responses remain
ambiguous; forbidden, authentication, network, rate, size and malformed-response
errors have separate codes. Probe evidence includes an observation timestamp.
Command compatibility is refreshed on every invocation, with executable metadata
identity recorded for diagnostics; there is no compatibility cache.

All child calls use absolute executable/cwd paths and argument arrays. Defaults
limit input to 1 MiB, each output stream to 4 MiB and exchange time to 20 seconds.
A separate two-second cleanup grace bounds direct-child reaping; Tokio retains
background reaping if the OS does not finish within that grace. Unix process
groups and Windows jobs own ordinary descendants. Children that deliberately
escape Unix process groups are outside this transport's containment guarantee.
Windows children start suspended and join the kill-on-close job before resuming.
Cancellation and dropping the operation terminate its owned tree. This transport
is designed for trusted native Git/forge CLIs, not arbitrary hostile executables.

JSON stdout is one object with `schema_version`, `version`, `operation`, `status`,
`exit`, `evidence`, and `diagnostics`. Invalid input exits 2, unavailable evidence
3, cancellation 130, successful observations 0. Observation success is not a
delivery verdict. Assessment rejection/acceptance will be introduced with #512.
Raw provider stderr is classified locally and never copied into diagnostics.
Offline status only invokes Git and explicitly refuses to reinterpret existing
legacy declarations before the version-aware migration is implemented.

The fixture binary is gated behind `test-fixtures` and is excluded from ordinary
installation. CI installs and runs the native artifact outside the checkout on
Linux, macOS and Windows; these tests do not establish npm distribution support.

## Global integration stage (#510)

`setup --provider github` now installs versioned native assets and a hook manifest
under the native per-user data directory. `--root <absolute-path>` isolates the
installation. `--register-claude` explicitly selects native Claude registration;
`--claude-settings <absolute-path>` selects an isolated host configuration. An
existing recorded registration is retained on refresh. Registration also places
the portable skill under that host configuration directory's `skills` folder.

The ownership receipt records exact asset hashes and host groups. User fields,
foreign hook ordering, pre-existing empty keys, and file permissions survive
refresh/uninstall. Edited or missing owned content causes a conflict. Each change
uses a bounded OS lock, expected-content/permission checks and atomic replacement.
Transactions retain private preimages. `setup --root <path> --rollback <id>`
restores an explicitly selected transaction, refusing later user edits; repeat the
host settings selection when recovering a removed registration. An interrupted
transaction is reported before further writes. Backup directories remain for
recovery after uninstall; unrelated files and directories are retained.

Assets may install while account readiness is unknown; JSON reports `installed`
separately from `readiness`, and exits 3 for unavailable read evidence. A written
registration remains `written_not_verified`. Context delivery, visible messages,
next-turn delivery and idle wake are separate evidence claims.

`hook` uses the native host protocol, not the ordinary CLI report envelope. It
bounds stdin and collection time, emits informational diagnostics with exit 0,
and remains silent for uninitialized projects and irrelevant tools. It never
emits a permission grant. Stop uses an informational system message rather than
requesting another model turn. Session/worktree/head context has a stable local
identifier. Full declaration validation belongs to #511; issue-selection checks,
background observation, durable deduplication and pending result delivery remain
integration work in #512/#492. These pending portions keep #510's integrated
acceptance unfinished.

A Claude Code 2.1.241 smoke used an installed binary, isolated configuration,
fake credentials and a loopback-only Messages API fixture. The real host executed
SessionStart/Stop and included the hook context identifier in its actual request;
there was one request, so Stop did not loop. The API response was synthetic. This
proves the host import/context construction path, not external model delivery or
human acknowledgment. The external model readback remains unverified.

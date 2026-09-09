# Native runtime foundation

This private development Cargo package builds the SpecGit 2 library and native
executable. It currently exposes `doctor` and offline `status`; project setup,
configuration, delivery assessment and distribution are subsequent programme
work. The TypeScript entrypoint remains authoritative during this staged rewrite.

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

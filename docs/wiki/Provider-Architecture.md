# Provider Architecture

The Rust runtime separates Issue and request write capabilities from observation. The core, watch and hooks cannot merge requests, close Issues, delete branches or administer settings. Authorized agent actions remain outside those runtime capabilities.

See [runtime development](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/README.md) for the current architecture and [native contract](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/REFERENCE.md) for observable behavior. The v1 TypeScript provider implementation is retired.

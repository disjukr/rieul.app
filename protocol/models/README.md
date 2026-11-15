# Protocol concurrency models

These bounded TLA+ models test specific safety properties of Rieul's
asynchronous protocols. Each suite describes the implementation boundaries it
models, the corresponding implementation tests, and any omitted behavior.
A passing model is not a proof of all production code.

| Suite                 | Scope                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Terminal](terminal/) | Exact attachment cleanup, vacancy-only fast attach, input authority epochs, and late browser input completion. |
| [Updater](updater/)   | macOS GUI handoff, work admission, and the exclusive swap barrier for regular and force updates.               |
| [Cluster](cluster/)   | Serialized primary handoff, durable seal, exact-prefix activation, and receipt recovery.                       |
| [Screen](screen/)     | Shared viewer lifetime, stale configuration, and control release.                                              |

From the repository root, run all suites or name a subset:

```sh
sh protocol/models/check.sh
sh protocol/models/check.sh terminal updater
```

Requires Java 21, curl, and `sha256sum` or `shasum`. The script downloads a
checksum-pinned official TLC jar to temporary storage. Set `TLA2TOOLS_JAR` to
reuse a local copy with the same checksum. No daemon, credentials, package
installation, or live device is needed.

Each record in `checks.txt` lists a suite, module, configuration, and optionally
an expected invariant violation. Negative safety cases deliberately remove a
guard. A few separately named coverage probes instead negate behavior that
should be reachable in the unchanged model. Parse errors, a different violated
invariant, or missing expected traces fail the driver. See each suite's README
for the complete trace commands. GitHub Actions runs the same matrix on model
changes.

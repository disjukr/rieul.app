# Solid v2 compatibility experiment

This isolated workspace proves selected migration boundaries; it does not port the application. Production files and the root dependency graph are unchanged. Base: `ea33bfa8469004819fbc34c1fe899e77e3535842`, including the Windows native callback fix `635ba59138b0dd776da8dd07f6e8fe119a3f8013`.

## Reproduce

Use Node 24 and pnpm 10.28.0. Install the root workspace first because the production fixture imports unchanged application source. Then, from this directory:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm build
pnpm exec playwright install chromium
pnpm test
pnpm test:gpuix
```

The nested workspace and lockfile deliberately keep prerelease dependencies out of the application. Solid, `@solidjs/web`, universal renderer and Babel compiler are pinned to `2.0.0-rc.20`; the official Vite plugin is `3.0.0-next.54` with Vite `8.3.5`. Solid v2 is a prerelease at the time of this experiment.

## Proven boundaries

- Official v2 web compiler/runtime builds both fixtures and renders them in Chromium.
- An app-local Bunja adapter uses the published v4 store API and static Bunja definitions. A store-local override replaces a dependency without introducing model factories.
- Two consumers share one instance and atom subscription. Removing the first owner leaves the second owner's Solid signal alive. Final removal releases the Bunja effect, owned root and atom observer; remount creates a new lifetime.
- Scope and Jotai store replacement reconnect subscriptions and release old instances. Roots must be anchored to the Provider: v2 roots inherit ownership. Scopes read during instance construction must also be tracked in the consumer memo. A failing scope-replacement test exposed and fixed this distinction.
- The actual production `machineStoreBunja` and `machineBunja` are imported directly. Tests cover shared persistence, selected-machine versus scoped-machine identity, partial/final removal, remount, and storage-domain replacement. No production model copy, factory or `-model` file is used.
- The Jotai bridge subscribes to the vanilla store, reads again after subscription to include atom `onMount` writes, and unsubscribes on replacement/disposal. Jotai remains the source of truth.
- The official v2 universal compiler can drive the published GPUiX host implementation through a small experimental runtime. Assertions cover insertion, event registration/dispatch, reactive text/style, conditional removal, disposal and no mutations after disposal.

## Limits and remaining migration work

`bunja/solid` 4.0.0-alpha.1 and `@gpuix/solid` 0.11.0 declare Solid v1 peers. Their shipped adapters still use v1 APIs; peer warnings are expected and do not establish upstream support. This experiment bypasses their Solid adapters, not their core models or host mutation logic. No upstream public API was edited or published.

The production fixture still loads React-linked imports through unchanged `unsaturated/store` and Jotai entry points. Build warnings about `use client` reflect that dependency boundary. This is proof that the state model survives a Solid consumer, **not** proof of a React-free bundle. The next step is an application-local vanilla store/clock boundary with consistent scope identities, then migration of actual screens. Panecake, Base UI, dnd-kit and React-specific editor/terminal wrappers still need equivalents preserving behavior.

The GPUiX experiment imports its private `dist/host.js` by resolving the published package path. It runs against the actual host tree and mutation queue but a fake native `applyBatch` renderer. It does **not** exercise a real native window, FFI, focus, accessibility, platform events, or existing GPUiX components. Its Node resolution hook selects the browser reactive runtime only inside this experiment. A production solution still needs a maintained app-local v2 renderer/compiler integration, migration of GPUiX context/effects/components, and real native lifecycle QA. Existing daemon UI remains on Solid 1.9.15 until that work is complete.

Async atom/Suspense behavior, SSR/hydration, seed overrides, error recovery, nested Providers and exhaustive event ordering are not established by these three browser tests. Do not promote these adapters to general-purpose library APIs based only on this proof.

## References

- [Solid v2 migration guide at the inspected ref](https://github.com/solidjs/solid/blob/50dec1b3a6ff9a8429b704669c990f0d6d00a028/documentation/solid-2.0/MIGRATION.md), plus installed rc.20 source and types.
- Bunja skill: `/Users/me/Documents/Codex/2026-10-27/task-3/bunja/skills/bunja/SKILL.md` and its Solid/design/patterns references. Its v1 Solid examples were checked against actual v2 behavior.
- [Official Jotai skill](https://github.com/jotaijs/jotai-skills/blob/44ebadb8fc0d151c645f3a39fb1e6db173e65463/skills/jotai/SKILL.md) and modeling, React, async, performance, TypeScript and version references.

Full application port, main integration, native packaging and the requested Mac installation update remain subsequent stages. This branch contains only a compatibility proof.

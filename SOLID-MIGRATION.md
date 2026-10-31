# Solid v2 migration

The browser application and native pairing UI use Solid `2.0.0-rc.20`. This is a pinned prerelease, not a stable v2 release. Browser compilation uses the official `@solidjs/vite-plugin` with Vite 8; the desktop universal renderer uses the matching official Babel compiler.

## State and rendering boundaries

Bunja `4.0.0-alpha.1` definitions remain static. `web/src/solid/bunja.tsx` adapts the published core store API to v2 ownership, context accessors and two-phase effects. Instance roots belong to the Provider, so removing the first consumer cannot dispose an instance still used elsewhere. Tests replace dependencies with store-local overrides instead of model factories.

Jotai `3.0.1` vanilla stores remain the canonical state. `web/src/solid/jotai.tsx` subscribes and cleans up on atom/store replacement, including synchronous atom mount writes. The application's store scope and shared clock no longer import a React adapter. `useBunja`, `useAtomValue`, and `useStore` return accessors; callers read them inside reactive scopes or capture an intentional operation snapshot.

The browser build rejects any resolved React/ReactDOM runtime module. React-only UI dependencies have been removed. Icons retain the original Lucide geometry and ISC notice as static SVG components. The app-specific pane renderer preserves the existing persisted layout format; the unchanged panecake 0.0.1 pure reducer and types are retained locally with source/license metadata. Golden reducer sequences verify split, resize, move and close compatibility.

`pairing/src/gpuix.tsx` is an application-local v2 universal binding over GPUiX's existing host mutation/event implementation. GPUiX's published Solid adapter still declares a v1 peer. The application does not use that adapter or alter upstream public APIs. Development compilation and shipped runtime preload are separate; shipped runtimes and new preload files remain covered by bundle integrity checks.

## Regression coverage

The original state and UI assertions remain, with Solid fixtures replacing React consumers. Additional tests cover:

- Provider override isolation, owned roots, atom/store replacement and final cleanup;
- terminal conditional host lifetime, delayed xterm import, late RPC creation, and stable attachment while session metadata changes;
- agent subscription cancellation and session replacement before transport resolves;
- Monaco model/focus/undo lifetime, language switching and delayed file-resource cleanup;
- modal/menu keyboard behavior and focus restoration, tooltip trigger association, file rename/path drafts;
- pointer/touch tab movement, retained tab DOM identity, pointer/keyboard pane resizing, and persisted layout parity.

Native verification includes actual Mac windows, keyboard approval, repeated request replacement/cancel/hide/reopen, isolated profiles and packaged embedded runtimes. See `pairing/VERIFICATION.md`. Windows and Intel Mac are validated by the native CI jobs on the integrated commit; local ARM evidence does not substitute for those jobs.

The isolated proof under `experiments/solid-v2` records the initial compatibility findings. Production adapters and application regressions are the maintained integration, while that experiment remains independently reproducible.

## Local checks

From the repository root, run `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test`, `pnpm test:ui`, and `pnpm build`. Install the pinned Playwright browser when needed. Native build/test/package commands remain under `pairing` and `scripts/macos` / `scripts/windows`.

The migration does not change user data locations or pairing identities. Desktop updates use the existing installer flow and preserve the external configuration and database. A locally built ad-hoc signed app does not preserve a developer certificate's OS trust identity; installation verification must distinguish that from data preservation.

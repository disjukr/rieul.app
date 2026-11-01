# Web styling

- Use `style`, `variants`, and `theme` from `src/zyzz.config.ts`. The HTML output is intentional for Solid 2: `class` plus serialized dynamic `style` values.
- Keep component styles in a module-level `namespace styles` beside the component. Use CSS properties and selectors; do not introduce utility class strings or another variant library.
- Reuse `theme` references. The existing `--rieul-*` values live in `src/theme.css` and remain available to canvas and third-party integrations. Keep the single layered reset import in `theme.css`; do not enable Zyzz's reset as well.
- Spread style applications on native elements. A static style's `.class` can be passed to an existing component's `className` prop. Always spread variant applications so their data attributes remain reactive.
- Use the application's `className` option for external classes. Zyzz's `cx` composes known local style applications; arbitrary props objects are not statically extractable composition inputs.
- Preserve semantic state classes used by interactions and descendant selectors. Keep Monaco, xterm, and PDF styling and lifetimes intact.
- Keep `zyzz()` before `solid()` in Vite. After changes run the repository's check, unit, build, and UI commands; inspect focus, hover, narrow viewports, and dynamic variant changes.

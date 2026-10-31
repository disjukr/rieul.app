// GPUiX's Bun plugin currently forces Solid's client runtime. Keep that
// requirement explicit for this Node-only compiler/host experiment.
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "solid-js" ||
      specifier.startsWith("solid-js/") ||
      specifier.startsWith("@solidjs/")
    ) {
      return nextResolve(specifier, {
        ...context,
        conditions: [
          ...context.conditions.filter((value) => value !== "node"),
          "browser",
        ],
      });
    }
    return nextResolve(specifier, context);
  },
});

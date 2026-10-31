import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import solid from "@solidjs/babel-plugin";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import type { BunPlugin } from "bun";
export function createSolidPlugin(): BunPlugin {
  return {
    name: "rieul-solid-v2",
    setup(build) {
      build.onResolve({ filter: /^#gpuix$/ }, () => ({
        path: fileURLToPath(new URL("../src/gpuix.tsx", import.meta.url)),
        external: false,
      }));
      // Native rendering needs the client reactive runtime even under Bun/Node.
      build.onLoad(
        { filter: /[/\\]solid-js[/\\]dist[/\\]server\.js$/ },
        async ({ path }) => ({
          contents: await readFile(
            path.replace("server.js", "solid.js"),
            "utf8",
          ),
          loader: "js",
        }),
      );
      build.onLoad(
        { filter: /^(?!.*[/\\]node_modules[/\\]).*\.tsx$/ },
        async ({ path }) => {
          const result = await transformAsync(await readFile(path, "utf8"), {
            filename: path,
            configFile: false,
            babelrc: false,
            plugins: [[solid, { generate: "universal", moduleName: "#gpuix" }]],
            presets: [typescript],
          });
          return { contents: result?.code ?? "", loader: "js" };
        },
      );
    },
  };
}

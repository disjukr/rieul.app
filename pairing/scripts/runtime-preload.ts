import { plugin } from "bun";
import { readFile } from "node:fs/promises";
await plugin({
  name: "rieul-solid-v2-client",
  setup(build) {
    build.onLoad(
      { filter: /[/\\]solid-js[/\\]dist[/\\]server\.js$/ },
      async ({ path }) => ({
        contents: await readFile(path.replace("server.js", "solid.js"), "utf8"),
        loader: "js",
      }),
    );
  },
});

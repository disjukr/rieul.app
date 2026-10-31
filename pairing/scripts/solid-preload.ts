import { plugin } from "bun";
import { createSolidPlugin } from "./solid-plugin.ts";
await plugin(createSolidPlugin());

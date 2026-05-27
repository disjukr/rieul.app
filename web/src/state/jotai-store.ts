import { createScope } from "bunja";
import { createStore } from "jotai";

export type JotaiStore = ReturnType<typeof createStore>;

export const JotaiStoreScope = createScope<JotaiStore>();

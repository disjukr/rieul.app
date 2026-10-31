import { createScope } from "bunja";
import type { Store } from "jotai/vanilla";

export type JotaiStore = Store;
export const JotaiStoreScope = createScope<Store>();

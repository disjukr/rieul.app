import { createContext } from "solid-js";
import { bindScope } from "../solid/bunja";
import {
  WorkbenchPaneIdScope,
  WorkbenchTabIdScope,
} from "./workbench-scopes.ts";

export {
  WorkbenchPaneIdScope,
  WorkbenchTabIdScope,
} from "./workbench-scopes.ts";
export const WorkbenchPaneIdContext = createContext<() => string | undefined>(
  () => undefined,
);
export const WorkbenchTabIdContext = createContext<() => string | undefined>(
  () => undefined,
);
bindScope(WorkbenchPaneIdScope, WorkbenchPaneIdContext);
bindScope(WorkbenchTabIdScope, WorkbenchTabIdContext);

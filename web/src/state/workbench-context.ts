import { createContext } from "solid-js";
import { bindScope } from "bunja/solid";
import {
  WorkbenchPaneIdScope,
  WorkbenchTabIdScope,
} from "./workbench-scopes.ts";

export {
  WorkbenchPaneIdScope,
  WorkbenchTabIdScope,
} from "./workbench-scopes.ts";
export const WorkbenchPaneIdContext = createContext<
  string | undefined | (() => string | undefined)
>(() => undefined);
export const WorkbenchTabIdContext = createContext<
  string | undefined | (() => string | undefined)
>(() => undefined);
bindScope(WorkbenchPaneIdScope, WorkbenchPaneIdContext);
bindScope(WorkbenchTabIdScope, WorkbenchTabIdContext);

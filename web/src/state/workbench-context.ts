import { createContext } from "react";
import { bindScope } from "bunja/react";
import {
  WorkbenchPaneIdScope,
  WorkbenchTabIdScope,
} from "./workbench-scopes.ts";

export {
  WorkbenchPaneIdScope,
  WorkbenchTabIdScope,
} from "./workbench-scopes.ts";
export const WorkbenchPaneIdContext = createContext<string | undefined>(
  undefined,
);
export const WorkbenchTabIdContext = createContext<string | undefined>(
  undefined,
);
bindScope(WorkbenchPaneIdScope, WorkbenchPaneIdContext);
bindScope(WorkbenchTabIdScope, WorkbenchTabIdContext);

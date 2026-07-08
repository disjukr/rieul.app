import { createContext } from "react";
import { createScopeFromContext } from "bunja/react";

export const WorkbenchPaneIdContext = createContext<string | undefined>(
  undefined,
);
export const WorkbenchTabIdContext = createContext<string | undefined>(
  undefined,
);
export const WorkbenchPaneIdScope = createScopeFromContext(
  WorkbenchPaneIdContext,
);
export const WorkbenchTabIdScope = createScopeFromContext(
  WorkbenchTabIdContext,
);

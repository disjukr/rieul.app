import { createContext } from "react";
import { bindScope } from "bunja/react";
import { MachineBaseUrlScope, MachineIdScope } from "./machine-scopes.ts";

export { MachineBaseUrlScope, MachineIdScope } from "./machine-scopes.ts";
export const MachineIdContext = createContext<string | undefined>(undefined);
export const MachineBaseUrlContext = createContext<string | undefined>(
  undefined,
);
bindScope(MachineIdScope, MachineIdContext);
bindScope(MachineBaseUrlScope, MachineBaseUrlContext);

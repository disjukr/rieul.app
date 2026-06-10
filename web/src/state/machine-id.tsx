import { createContext } from "react";
import { createScopeFromContext } from "bunja/react";

export const MachineIdContext = createContext<string | undefined>(undefined);
export const MachineIdScope = createScopeFromContext(MachineIdContext);

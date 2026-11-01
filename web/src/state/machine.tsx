import { createContext } from "solid-js";
import { bindScope } from "bunja/solid";
import { MachineBaseUrlScope, MachineIdScope } from "./machine-scopes.ts";

export { MachineBaseUrlScope, MachineIdScope } from "./machine-scopes.ts";
export const MachineIdContext = createContext<
  string | undefined | (() => string | undefined)
>(() => undefined);
export const MachineBaseUrlContext = createContext<
  string | undefined | (() => string | undefined)
>(() => undefined);
bindScope(MachineIdScope, MachineIdContext);
bindScope(MachineBaseUrlScope, MachineBaseUrlContext);

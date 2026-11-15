import { createContext } from "solid-js";
import { bindScope } from "bunja/solid";
import { DesktopDisplayIdScope } from "./desktop-scopes.ts";

export const DesktopDisplayIdContext = createContext<
  string | undefined | (() => string | undefined)
>(() => undefined);
bindScope(DesktopDisplayIdScope, DesktopDisplayIdContext);

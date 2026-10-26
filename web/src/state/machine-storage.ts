import { createContext } from "react";
import { createScopeFromContext } from "bunja/react";

export type MachineStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

// Resolve the browser storage lazily: importing state must not read persistence.
const browserMachineStorage: MachineStorage = {
  getItem: (key) => globalThis.localStorage.getItem(key),
  setItem: (key, value) => globalThis.localStorage.setItem(key, value),
  removeItem: (key) => globalThis.localStorage.removeItem(key),
};

// Keep the value stable for one persistence domain. Replacing it creates a new
// machine store; initial data is read once per Bunja lifetime, not used as identity.
export const MachineStorageContext = createContext(browserMachineStorage);
export const MachineStorageScope = createScopeFromContext(
  MachineStorageContext,
);

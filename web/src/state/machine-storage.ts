import { createScope } from "bunja";

export type MachineStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

// Resolve the browser storage lazily: importing state must not read persistence.
export const browserMachineStorage: MachineStorage = {
  getItem: (key) => globalThis.localStorage.getItem(key),
  setItem: (key, value) => globalThis.localStorage.setItem(key, value),
  removeItem: (key) => globalThis.localStorage.removeItem(key),
};

// Keep the value stable for one persistence domain. Replacing it creates a new
// machine store; initial data is read once per Bunja lifetime, not used as identity.
export const MachineStorageScope = createScope<MachineStorage>();

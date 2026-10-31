import { createContext } from "solid-js";
import { bindScope } from "./bunja";
import {
  browserMachineStorage,
  MachineStorageScope,
  type MachineStorage,
} from "../state/machine-storage.ts";

export const MachineStorageContext = createContext<() => MachineStorage>(
  () => browserMachineStorage,
);
bindScope(MachineStorageScope, MachineStorageContext);

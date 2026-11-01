import { createContext } from "solid-js";
import { bindScope } from "bunja/solid";
import {
  browserMachineStorage,
  MachineStorageScope,
  type MachineStorage,
} from "../state/machine-storage.ts";

export const MachineStorageContext = createContext<
  MachineStorage | (() => MachineStorage)
>(() => browserMachineStorage);
bindScope(MachineStorageScope, MachineStorageContext);

import { createScope } from "bunja";

// Domain identity belongs to the Bunja graph. UI adapters bind these same
// objects to their framework's providers; initial data is not scope identity.
export const MachineIdScope = createScope<string | undefined>();
export const MachineBaseUrlScope = createScope<string | undefined>();

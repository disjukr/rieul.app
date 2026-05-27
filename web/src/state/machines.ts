export interface Machine {
  id: string;
  name: string;
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
}

const STORAGE_KEY = "wgo.machines.v1";

export function loadMachines(): Machine[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizeMachine(item))
      .filter((item): item is Machine => item !== undefined);
  } catch {
    return [];
  }
}

export function saveMachines(machines: Machine[]) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(machines.map(normalizeStoredMachine)),
  );
}

export function normalizeMachineUrl(raw: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${raw}`;
  const url = new URL(withScheme);
  if (url.protocol !== "https:") {
    throw new Error("Machine URL must use https");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizeMachine(item: unknown): Machine | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.baseUrl !== "string") {
    return undefined;
  }
  try {
    return {
      id: record.id,
      name: typeof record.name === "string" && record.name.trim()
        ? record.name
        : new URL(normalizeMachineUrl(record.baseUrl)).hostname,
      baseUrl: normalizeMachineUrl(record.baseUrl),
      clientId: typeof record.clientId === "string"
        ? record.clientId
        : undefined,
      clientSecret: typeof record.clientSecret === "string"
        ? record.clientSecret
        : undefined,
    };
  } catch {
    return undefined;
  }
}

function normalizeStoredMachine(machine: Machine): Machine {
  return {
    ...machine,
    baseUrl: normalizeMachineUrl(machine.baseUrl),
  };
}

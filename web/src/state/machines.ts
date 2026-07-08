export interface Machine {
  id: string;
  name: string;
  baseUrl: string;
  icon?: MachineIconName;
  clientId?: string;
  clientSecret?: string;
  clientCredentialExpiresAtUnix?: number;
}

export const machineIconNames = [
  "monitor",
  "laptop",
  "server",
  "cpu",
  "hard-drive",
  "router",
  "circuit-board",
  "pc-case",
] as const;

export type MachineIconName = typeof machineIconNames[number];

const STORAGE_KEY = "rieul.machines.v1";
const DEFAULT_MACHINE_PORT = "9012";

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
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const hasPort = hasExplicitPort(withScheme);
  const url = new URL(withScheme);
  if (url.protocol !== "https:") {
    throw new Error("Machine URL must use https");
  }
  if (!hasPort) url.port = DEFAULT_MACHINE_PORT;
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function hasExplicitPort(rawUrl: string): boolean {
  const authority =
    rawUrl.slice(rawUrl.indexOf("://") + 3).split(/[/?#]/, 1)[0] ??
      "";
  if (authority.startsWith("[")) {
    return /^\[[^\]]+\]:\d+$/.test(authority);
  }
  return /:\d+$/.test(authority);
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
      icon: normalizeMachineIcon(record.icon),
      clientId: typeof record.clientId === "string"
        ? record.clientId
        : undefined,
      clientSecret: typeof record.clientSecret === "string"
        ? record.clientSecret
        : undefined,
      clientCredentialExpiresAtUnix:
        typeof record.clientCredentialExpiresAtUnix ===
            "number" &&
          Number.isSafeInteger(record.clientCredentialExpiresAtUnix)
          ? record.clientCredentialExpiresAtUnix
          : undefined,
    };
  } catch {
    return undefined;
  }
}

function normalizeMachineIcon(value: unknown): MachineIconName | undefined {
  return typeof value === "string" &&
      machineIconNames.includes(value as MachineIconName)
    ? value as MachineIconName
    : undefined;
}

function normalizeStoredMachine(machine: Machine): Machine {
  return {
    ...machine,
    baseUrl: normalizeMachineUrl(machine.baseUrl),
  };
}

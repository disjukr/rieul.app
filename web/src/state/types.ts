export type ConnectionState =
  | { phase: "idle"; message: string }
  | { phase: "checking"; message: string }
  | { phase: "reachable"; message: string; latencyMs: number }
  | { phase: "offline"; message: string };

export type StreamState =
  | { phase: "idle"; message: string }
  | { phase: "connecting"; message: string }
  | { phase: "live"; message: string }
  | { phase: "closed"; message: string }
  | { phase: "error"; message: string };

export type MachineModalMode = "add" | "pair" | "config" | "delete";
export type MachineMenuState = { machineId: string; x: number; y: number };
export type RailTooltipState = { name: string; x: number; y: number };

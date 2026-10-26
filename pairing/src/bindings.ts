export interface DaemonInfoModel {
  configPath: string;
  daemonUrl: string;
  daemonVersion: string;
  profileId: string;
}

export interface PairingCodeModel {
  daemonUrl: string;
  pairingCode: string;
  expiresInSeconds: number;
}

export interface PairingConfirmationModel {
  daemonUrl: string;
  confirmationCode: string;
  clientLabel: string;
  candidates: string[];
}

export type DaemonMainRoute =
  | { kind: "daemonInfo"; model: DaemonInfoModel }
  | { kind: "pairingCode"; model: PairingCodeModel }
  | { kind: "confirmPairing"; model: PairingConfirmationModel }
  | { kind: "idle"; model: DaemonInfoModel };

export interface DaemonMainSnapshot {
  desktopApiUrl: string;
  route: DaemonMainRoute;
}

export interface DaemonMainBindings {
  getSnapshot(): Promise<DaemonMainSnapshot>;
  openConfig(): Promise<void>;
  showDaemonInfo(): Promise<void>;
  resolvePairingConfirmation(accepted: boolean): Promise<void>;
}

declare global {
  const bindings: DaemonMainBindings | undefined;
}

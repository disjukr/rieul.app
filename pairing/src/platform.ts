/** Toolkit-independent platform contract. One native window/status item per UI process. */
export interface NativeShell {
  show(): void;
  hide(): void;
  visible(): boolean;
  requestClose(): void;
  /** false requests the controller's visible-window fallback; never grants OS permission. */
  notify(title: string, body: string): Promise<boolean>;
  destroy(): void;
}
export interface ShellCallbacks {
  onClose(): void;
  onOpen(): void;
  onDaemonInfo(): void;
  onQuit(): void;
}

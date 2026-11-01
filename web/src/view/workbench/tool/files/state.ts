import { bunja } from "bunja";
import { terminalShellsBunja } from "../../../../state/terminal-shells.ts";

export const filesToolBunja = bunja(() => {
  const terminalShells = bunja.use(terminalShellsBunja);

  return {
    defaultShell: terminalShells.defaultShell,
    terminalShells: terminalShells.terminalShells,
  };
});

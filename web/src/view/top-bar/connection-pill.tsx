import { RefreshCw } from "lucide-react";
import type { Machine } from "../../state/machines.ts";
import type { ConnectionState } from "../../state/types.ts";

interface ConnectionPillProps {
  machine?: Machine;
  connection: ConnectionState;
  onRefresh: () => void;
}

export function ConnectionPill(
  { machine, connection, onRefresh }: ConnectionPillProps,
) {
  if (!machine) return null;

  const checking = connection.phase === "checking";
  const connected = connection.phase === "reachable";
  const label = checking
    ? "Connecting"
    : connected
    ? "Connected"
    : "Unconnected";
  const className = [
    "global-connection-pill",
    connected ? "connected" : "",
    checking ? "checking" : "",
  ].filter(Boolean).join(" ");

  return (
    <button
      type="button"
      className={className}
      onClick={onRefresh}
      title={checking ? "Connecting" : connection.message}
      aria-label={checking ? "Connecting" : `Connection status: ${label}`}
      aria-busy={checking}
    >
      <span className="global-connection-status-icon" aria-hidden="true">
        <span className="global-connection-dot" />
        <RefreshCw
          size={13}
          className={checking
            ? "global-connection-refresh spin"
            : "global-connection-refresh"}
        />
      </span>
      <span>{label}</span>
    </button>
  );
}

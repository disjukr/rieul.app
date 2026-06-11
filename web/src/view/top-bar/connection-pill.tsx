import { RefreshCw } from "lucide-react";
import type { Machine } from "../../state/machines.ts";
import type { ConnectionState } from "../../state/types.ts";
import { className } from "../class-name.ts";

const connectionPillClassName = [
  "inline-flex justify-self-end items-center gap-[6px] min-h-[22px]",
  "border border-[#444b5c] rounded-full bg-transparent text-[#cbd3df]",
  "px-[8px] text-[11px] font-700 whitespace-nowrap",
  "hover:border-[#566074] hover:bg-[#343946] hover:text-white",
  "focus-visible:border-[#566074] focus-visible:bg-[#343946] focus-visible:text-white",
  "active:translate-y-[1px]",
  "[&.checking]:border-[#566074] [&.checking]:bg-[#343946] [&.checking]:text-white",
  "[&.connected_.connection-dot]:bg-[#22c55e]",
  "[&:hover_.connection-dot]:opacity-0",
  "[&:focus-visible_.connection-dot]:opacity-0",
  "[&.checking_.connection-dot]:opacity-0",
  "[&:hover_.connection-refresh]:opacity-100",
  "[&:focus-visible_.connection-refresh]:opacity-100",
  "[&.checking_.connection-refresh]:opacity-100",
].join(" ");
const statusIconClassName =
  "relative inline-flex items-center justify-center w-[14px] h-[14px]";
const connectionDotClassName = [
  "connection-dot absolute w-[7px] h-[7px] rounded-full bg-[#f04438]",
  "[transition:opacity_0.12s_ease]",
].join(" ");
const connectionRefreshClassName = [
  "connection-refresh absolute opacity-0 [transition:opacity_0.12s_ease]",
].join(" ");

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
  const buttonClassName = className(
    connectionPillClassName,
    connected && "connected",
    checking && "checking",
  );

  return (
    <button
      type="button"
      className={buttonClassName}
      onClick={onRefresh}
      title={checking ? "Connecting" : connection.message}
      aria-label={checking ? "Connecting" : `Connection status: ${label}`}
      aria-busy={checking}
    >
      <span className={statusIconClassName} aria-hidden="true">
        <span className={connectionDotClassName} />
        <RefreshCw
          size={13}
          className={className(
            connectionRefreshClassName,
            checking && "animate-spin",
          )}
        />
      </span>
      <span>{label}</span>
    </button>
  );
}

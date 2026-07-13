import React, { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  CircleAlert,
  Clipboard,
  ExternalLink,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "../ui/button.tsx";
import { Badge } from "../ui/badge.tsx";
import {
  PropertyList,
  PropertyListItem,
  PropertyValue,
} from "../ui/property-list.tsx";
import { className } from "../class-name.ts";
import type {
  DaemonInfoModel,
  DaemonMainSnapshot,
  PairingCodeModel,
  PairingConfirmationModel,
} from "../../desktop-bindings.d.ts";
import { desktopConfigPathFromUrl } from "../../desktop-context.ts";

const fallbackInfo: DaemonInfoModel = {
  configPath: desktopConfigPathFromUrl(globalThis.location.href) ??
    "Not connected",
  daemonUrl: "https://localhost:9012",
  daemonVersion: "dev",
  profileId: "preview",
};

const fallbackSnapshot: DaemonMainSnapshot = {
  desktopApiUrl: "",
  route: { kind: "idle", model: fallbackInfo },
};

const shellClassName = [
  "relative isolate h-full min-h-0 overflow-hidden bg-rieul-canvas",
  "[background:radial-gradient(circle_at_18%_8%,rgba(79,140,255,0.18),transparent_31%),radial-gradient(circle_at_86%_18%,rgba(56,184,111,0.12),transparent_29%),var(--rieul-canvas-background)]",
  "text-rieul-text font-rieul",
].join(" ");
const contentClassName = [
  "h-full min-h-0 px-[18px] py-[18px]",
].join(" ");
const windowClassName = [
  "rieul-material-window h-full min-h-0 overflow-hidden rounded-rieul-2xl",
].join(" ");
const headerClassName = [
  "flex min-w-0 items-center justify-between gap-[14px]",
  "border-b border-white/38 px-[18px] py-[14px]",
].join(" ");
const routedBodyClassName = "min-h-0 overflow-hidden p-[16px]";
const titleClassName = "m-0 text-[18px] font-800 tracking-[0] text-rieul-text";
const actionRowClassName = "mt-[18px] flex flex-wrap items-center gap-[8px]";
const routedScreenClassName =
  "grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]";

export function DaemonMainView() {
  const [snapshot, setSnapshot] = useState<DaemonMainSnapshot>(
    fallbackSnapshot,
  );
  const [busy, setBusy] = useState(false);
  const route = snapshot.route;

  useEffect(() => {
    let disposed = false;
    function refreshSnapshot(event?: Event) {
      const pushedSnapshot =
        (event as CustomEvent<DaemonMainSnapshot> | undefined)
          ?.detail;
      if (pushedSnapshot) {
        setSnapshot(pushedSnapshot);
        return;
      }
      bindings?.getSnapshot()
        .then((next) => {
          if (!disposed) setSnapshot(next);
        })
        .catch(() => {
          if (!disposed) setSnapshot(fallbackSnapshot);
        });
    }

    refreshSnapshot();
    globalThis.addEventListener("rieul-daemon-snapshot", refreshSnapshot);
    return () => {
      disposed = true;
      globalThis.removeEventListener("rieul-daemon-snapshot", refreshSnapshot);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const interval = globalThis.setInterval(() => {
      bindings?.getSnapshot().then((next) => {
        if (!disposed) setSnapshot(next);
      });
    }, 1000);
    return () => {
      disposed = true;
      globalThis.clearInterval(interval);
    };
  }, []);

  async function copy(text: string) {
    setBusy(true);
    try {
      await navigator.clipboard.writeText(text);
    } finally {
      setBusy(false);
    }
  }

  async function resolvePairingConfirmation(accepted: boolean) {
    setBusy(true);
    try {
      if (snapshot.desktopApiUrl) {
        const response = await fetch(
          `${snapshot.desktopApiUrl}/api/gui/resolve-pairing-confirmation`,
          {
            body: JSON.stringify({ accepted }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        if (!response.ok) {
          throw new Error(`Pairing confirmation failed: ${response.status}`);
        }
      } else {
        if (typeof bindings === "undefined") {
          throw new Error("Desktop bindings are unavailable");
        }
        await bindings.resolvePairingConfirmation(accepted);
      }
    } catch (error) {
      console.error("Failed to resolve pairing confirmation", error);
    } finally {
      setBusy(false);
    }
  }

  async function openConfig() {
    if (snapshot.desktopApiUrl) {
      const response = await fetch(
        `${snapshot.desktopApiUrl}/api/gui/open-config`,
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(`Opening config failed: ${response.status}`);
      }
      return;
    }
    if (typeof bindings === "undefined") {
      throw new Error("Desktop bindings are unavailable");
    }
    await bindings.openConfig();
  }

  return (
    <main className={shellClassName}>
      <section className={contentClassName}>
        <div className={windowClassName}>
          {route.kind === "daemonInfo" || route.kind === "idle"
            ? (
              <DaemonInfoScreen
                model={route.model}
                busy={busy}
                onCopy={copy}
                onOpenConfig={openConfig}
              />
            )
            : route.kind === "pairingCode"
            ? (
              <PairingCodeScreen
                model={route.model}
                busy={busy}
                onCopy={copy}
              />
            )
            : (
              <ConfirmPairingScreen
                model={route.model}
                busy={busy}
                onResolve={resolvePairingConfirmation}
              />
            )}
        </div>
      </section>
    </main>
  );
}

interface DaemonInfoScreenProps {
  busy: boolean;
  model: DaemonInfoModel;
  onCopy(text: string): Promise<void>;
  onOpenConfig(): Promise<void>;
}
function DaemonInfoScreen(
  { busy, model, onCopy, onOpenConfig }: DaemonInfoScreenProps,
) {
  const clientUrl = rieulAppUrl(model.daemonUrl);
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [model.daemonUrl]);
  useEffect(() => {
    if (!copied) return;
    const timeout = globalThis.setTimeout(() => setCopied(false), 1_500);
    return () => globalThis.clearTimeout(timeout);
  }, [copied]);

  async function copyDaemonUrl() {
    await onCopy(model.daemonUrl);
    setCopied(true);
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[168px_minmax(0,1fr)] items-center gap-[18px] overflow-hidden p-[18px]">
      <div className="grid aspect-square w-[168px] place-items-center rounded-rieul-xl border border-white/46 bg-white p-[10px] shadow-rieul-sm">
        <QRCodeSVG
          value={clientUrl}
          size={146}
          level="M"
          marginSize={0}
          bgColor="#ffffff"
          fgColor="#202632"
          title="Open rieul.app with this daemon URL"
        />
      </div>
      <PropertyList className="w-full">
        <PropertyListItem label="Daemon URL" valueClassName="!block">
          <div className="flex w-full min-w-0 items-center gap-[8px]">
            <PropertyValue className="min-w-0 flex-1">
              {model.daemonUrl}
            </PropertyValue>
            <div className="shrink-0">
              <Button
                size="icon"
                variant="ghost"
                aria-label={copied ? "Daemon URL copied" : "Copy daemon URL"}
                title={copied ? "Copied" : "Copy daemon URL"}
                disabled={busy}
                onClick={copyDaemonUrl}
              >
                {copied
                  ? <Check size={16} className="text-rieul-accent" />
                  : <Clipboard size={15} />}
              </Button>
            </div>
          </div>
        </PropertyListItem>
        <PropertyListItem label="Config" valueClassName="!block">
          <div className="flex w-full min-w-0 items-center gap-[8px]">
            <PropertyValue className="min-w-0 flex-1">
              {model.configPath}
            </PropertyValue>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Open config"
              title="Open config"
              onClick={onOpenConfig}
            >
              <ExternalLink size={15} />
            </Button>
          </div>
        </PropertyListItem>
      </PropertyList>
    </div>
  );
}

interface PairingCodeScreenProps {
  busy: boolean;
  model: PairingCodeModel;
  onCopy(text: string): Promise<void>;
}
function PairingCodeScreen({ busy, model, onCopy }: PairingCodeScreenProps) {
  const [remainingSeconds, setRemainingSeconds] = useState(
    model.expiresInSeconds,
  );
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const expiresAt = Date.now() + model.expiresInSeconds * 1_000;
    const update = () => {
      setRemainingSeconds(
        Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000)),
      );
    };
    update();
    const interval = globalThis.setInterval(update, 250);
    return () => globalThis.clearInterval(interval);
  }, [model.pairingCode, model.expiresInSeconds]);
  useEffect(() => {
    setCopied(false);
  }, [model.pairingCode]);
  useEffect(() => {
    if (!copied) return;
    const timeout = globalThis.setTimeout(() => setCopied(false), 1_500);
    return () => globalThis.clearTimeout(timeout);
  }, [copied]);

  async function copyCode() {
    await onCopy(model.pairingCode);
    setCopied(true);
  }

  const remaining = formatRemainingTime(remainingSeconds);
  return (
    <div className={routedScreenClassName}>
      <ScreenHeader
        title="Pairing code"
        badge={
          <Badge size="sm" tone="warning" variant="soft">{remaining}</Badge>
        }
      />
      <div className={routedBodyClassName}>
        <button
          type="button"
          aria-label="Copy pairing code"
          disabled={busy}
          className={className(
            "relative flex h-full min-h-[112px] w-full appearance-none items-center justify-center",
            "cursor-pointer rounded-rieul-xl border border-white/46 bg-white/36 px-[24px]",
            "shadow-rieul-sm rieul-transition hover:border-rieul-accent hover:bg-white/52",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-rieul-focus",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
          onClick={copyCode}
        >
          <span className="absolute right-[14px] top-[14px] flex items-center gap-[8px] text-rieul-text-3">
            <span
              role="status"
              aria-live="polite"
              className={className(
                "rounded-rieul-sm bg-rieul-text px-[7px] py-[3px] text-[11px] font-750 text-white",
                "rieul-transition",
                copied ? "opacity-100" : "pointer-events-none opacity-0",
              )}
            >
              {copied ? "Copied" : ""}
            </span>
            <Clipboard size={17} aria-hidden="true" />
          </span>
          <div className="font-mono text-[42px] font-850 tracking-[0.12em] text-rieul-text">
            {model.pairingCode}
          </div>
        </button>
      </div>
    </div>
  );
}

interface ConfirmPairingScreenProps {
  busy: boolean;
  model: PairingConfirmationModel;
  onResolve(accepted: boolean): Promise<void>;
}
function ConfirmPairingScreen(
  { busy, model, onResolve }: ConfirmPairingScreenProps,
) {
  const [incorrect, setIncorrect] = useState(false);
  useEffect(() => {
    setIncorrect(false);
  }, [model.confirmationCode, model.clientLabel, model.daemonUrl]);

  async function selectCandidate(candidate: string) {
    const correct = candidate === model.confirmationCode;
    await onResolve(correct);
    if (!correct) setIncorrect(true);
  }

  return (
    <div className={routedScreenClassName}>
      <ScreenHeader title="Select the code shown on your client." />
      <div className={routedBodyClassName}>
        <div className="grid gap-[8px]">
          <div className="min-w-0 rounded-rieul-xl border border-white/42 bg-white/32 px-[14px] py-[9px]">
            <div className="text-[11px] font-750 uppercase text-rieul-text-3">
              Client
            </div>
            <div className="mt-[2px] break-words text-[15px] font-800 text-rieul-text">
              {pairingClientLabel(model.clientLabel)}
            </div>
            <div className="mt-[6px] flex min-w-0 items-start gap-[6px] text-[11px] leading-[14px]">
              <span className="shrink-0 font-700 text-rieul-accent">
                Wants to connect to daemon
              </span>
              <ArrowRight
                size={14}
                className="shrink-0 text-rieul-accent"
                aria-hidden="true"
              />
              <span className="min-w-0 break-all text-rieul-text-2">
                {model.daemonUrl}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-[10px]">
            {model.candidates.map((candidate) => {
              const correct = candidate === model.confirmationCode;
              return (
                <button
                  key={candidate}
                  type="button"
                  disabled={busy || incorrect}
                  className={className(
                    "h-[58px] rounded-rieul-xl border text-[28px] font-850 tracking-[0]",
                    "bg-white/46 shadow-rieul-sm rieul-transition",
                    "hover:border-rieul-accent hover:bg-white/68",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-rieul-focus",
                    "disabled:cursor-not-allowed",
                    incorrect && correct && "border-rieul-accent bg-white/72",
                    incorrect && !correct && "opacity-45",
                  )}
                  onClick={() => selectCandidate(candidate)}
                >
                  {candidate}
                </button>
              );
            })}
          </div>
          {incorrect && (
            <div
              role="alert"
              className="flex items-center gap-[6px] px-[2px] text-[12px] leading-[16px] text-rieul-danger"
            >
              <CircleAlert size={14} className="shrink-0" aria-hidden="true" />
              That code did not match. Please start pairing again from the
              client.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface ScreenHeaderProps {
  badge?: React.ReactNode;
  title: string;
}
function ScreenHeader({ badge, title }: ScreenHeaderProps) {
  return (
    <header className={headerClassName}>
      <h2 className={titleClassName}>{title}</h2>
      {badge}
    </header>
  );
}

function formatRemainingTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60).toString().padStart(2, "0");
  const rest = (safe % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function pairingClientLabel(label: string): string {
  const trimmed = label.trim();
  return trimmed === "" ? "Unknown client" : trimmed;
}

function rieulAppUrl(daemonUrl: string): string {
  const url = new URL("https://rieul.app/");
  url.searchParams.set("daemonUrl", daemonUrl);
  return url.toString();
}

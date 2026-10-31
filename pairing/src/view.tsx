import { createSignal, For, onCleanup, Show } from "solid-js";
import { Button, useGpuixRequired, type HostElement } from "./gpuix.tsx";
import QRCode from "qrcode";
import {
  text,
  button,
  column,
  row,
  panel,
  smallShadow,
  backdropPixels,
  mono,
  icon,
} from "./appearance.ts";
import type { PairingController } from "./controller.ts";
import type { DaemonMainSnapshot } from "./bindings.ts";

export type ViewController = Pick<
  PairingController,
  | "getSnapshot"
  | "generation"
  | "subscribe"
  | "showDaemonInfo"
  | "openConfig"
  | "resolvePairingConfirmation"
  | "close"
>;
export function PairingView(props: {
  controller: ViewController;
  initial: DaemonMainSnapshot;
  copy(text: string): Promise<void>;
}) {
  const renderer = useGpuixRequired();
  const [state, setState] = createSignal({
    snapshot: props.initial,
    generation: props.controller.generation,
  });
  const [error, setError] = createSignal("");
  const [copied, setCopied] = createSignal(false);
  let live = true;
  onCleanup(() => {
    live = false;
  });
  const mountBackdrop = (element: HostElement) => {
    // Solid refs run before GPUiX assigns IDs and flushes native creation.
    // The root flushes synchronously after render; defer the native upload.
    queueMicrotask(() => {
      if (!live || !element.mounted) return;
      try {
        const image = backdropPixels();
        renderer.setImagePixels?.(
          element.id,
          image.width,
          image.height,
          image.pixels,
        );
      } catch (error) {
        setError(String(error));
      }
    });
  };
  const unsubscribe = props.controller.subscribe((snapshot) => {
    setCopied(false);
    setError("");
    setState({ snapshot, generation: props.controller.generation });
  });
  onCleanup(unsubscribe);
  const act = (action: () => Promise<void>) => {
    void action().catch((error) => setError(String(error)));
  };
  const copy = (text: string) =>
    act(async () => {
      await props.copy(text);
      setCopied(true);
    });
  function Screen(p: { state: ReturnType<typeof state> }) {
    const route = p.state.snapshot.route;
    const [remaining, setRemaining] = createSignal(
      route.kind === "pairingCode" ? route.model.expiresInSeconds : 0,
    );
    let timer: ReturnType<typeof setInterval> | undefined;
    if (route.kind === "pairingCode") {
      const expires = Date.now() + route.model.expiresInSeconds * 1000;
      timer = setInterval(
        () =>
          setRemaining(Math.max(0, Math.ceil((expires - Date.now()) / 1000))),
        250,
      );
    }
    onCleanup(() => clearInterval(timer));
    const [resolved, setResolved] = createSignal(false);
    const [incorrect, setIncorrect] = createSignal(false);
    const [cancelled, setCancelled] = createSignal(false);
    const select = (candidate: string) => {
      if (route.kind !== "confirmPairing" || resolved()) return;
      const accepted = candidate === route.model.confirmationCode;
      act(async () => {
        await props.controller.resolvePairingConfirmation(
          accepted,
          p.state.generation,
        );
        setIncorrect(!accepted);
        setResolved(true);
      });
    };
    const time = () =>
      `${Math.floor(remaining() / 60)
        .toString()
        .padStart(2, "0")}:${(remaining() % 60).toString().padStart(2, "0")}`;
    return (
      <div style={{ ...column, flexGrow: 1 }}>
        <Show
          when={route.kind === "confirmPairing" || route.kind === "pairingCode"}
        >
          <div
            style={{
              ...row,
              justifyContent: "space-between",
              gap: 14,
              paddingLeft: 18,
              paddingRight: 18,
              paddingTop: 14,
              paddingBottom: 14,
              borderBottomWidth: 1,
              borderColor: "#ffffff61",
            }}
          >
            <div style={{ ...row, height: 27 }}>
              <text
                testId="route-title"
                style={{
                  ...text,
                  fontSize: 18,
                  lineHeight: 27,
                  fontWeight: 800,
                }}
              >
                {route.kind === "confirmPairing"
                  ? "Select the code shown on your client."
                  : "Pairing code"}
              </text>
            </div>
            <Show when={route.kind === "pairingCode"}>
              <text
                testId="expiry"
                style={{
                  color: "#8a6116",
                  backgroundColor: "#fff8df",
                  fontSize: 11,
                  lineHeight: 11,
                  fontWeight: 750,
                  paddingLeft: 4,
                  paddingRight: 4,
                  borderWidth: 1,
                  borderColor: "#e4c778",
                  borderRadius: 999,
                }}
              >
                {time()}
              </text>
            </Show>
          </div>
        </Show>
        {route.kind === "confirmPairing" ? (
          <div style={{ ...column, padding: 16, gap: 8, flexGrow: 1 }}>
            <div
              style={{
                ...column,
                paddingLeft: 14,
                paddingRight: 14,
                paddingTop: 9,
                paddingBottom: 9,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: "#ffffff6b",
                backgroundColor: "#ffffff52",
              }}
            >
              <text
                style={{
                  color: "#667085",
                  fontSize: 11,
                  lineHeight: 16.5,
                  fontWeight: 750,
                }}
              >
                CLIENT
              </text>
              <text
                testId="client-label"
                style={{
                  ...text,
                  marginTop: 2,
                  fontSize: 15,
                  lineHeight: 22.5,
                  fontWeight: 800,
                }}
              >
                {route.model.clientLabel.trim() || "Unknown client"}
              </text>
              <div
                style={{
                  ...row,
                  alignItems: "flex-start",
                  marginTop: 6,
                  gap: 6,
                }}
              >
                <text
                  style={{
                    color: "#4f8cff",
                    fontSize: 11,
                    lineHeight: 14,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  Wants to connect to daemon →
                </text>
                <text
                  style={{
                    color: "#475467",
                    fontSize: 11,
                    lineHeight: 14,
                    flexGrow: 1,
                    flexBasis: 0,
                    minWidth: 0,
                  }}
                >
                  {route.model.daemonUrl}
                </text>
              </div>
            </div>
            <div style={{ ...row, gap: 10 }}>
              <For each={route.model.candidates}>
                {(candidate) => (
                  <Button
                    testId={`candidate-${candidate}`}
                    aria-label={candidate}
                    disabled={resolved()}
                    onClick={() => select(candidate)}
                    style={{
                      ...button,
                      height: 58,
                      flexGrow: 1,
                      flexBasis: 0,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor:
                        incorrect() &&
                        candidate === route.model.confirmationCode
                          ? "#4f8cff"
                          : "#d8dde7",
                      backgroundColor: "#f9f9fa",
                      fontSize: 28,
                      lineHeight: 42,
                      fontWeight: 850,
                      boxShadow: smallShadow,
                      opacity:
                        incorrect() &&
                        candidate !== route.model.confirmationCode
                          ? 0.45
                          : 1,
                      hover: {
                        borderColor: "#4f8cff",
                        backgroundColor: "#fcfcfd",
                      },
                    }}
                  >
                    {candidate}
                  </Button>
                )}
              </For>
            </div>
            <Show when={incorrect()}>
              <div style={{ ...row, gap: 6 }}>
                <svg
                  source={icon("alert")}
                  style={{
                    width: 14,
                    height: 14,
                    flexShrink: 0,
                    color: "#b42318",
                  }}
                />
                <text
                  testId="incorrect"
                  style={{ color: "#b42318", fontSize: 12 }}
                >
                  That code did not match. Please start pairing again from the
                  client.
                </text>
              </div>
            </Show>
            <Show when={resolved() && !incorrect() && !cancelled()}>
              <text testId="accepted" style={text}>
                Approval sent.
              </text>
            </Show>
            <Show when={resolved() && cancelled()}>
              <text testId="cancelled" style={text}>
                Pairing cancelled.
              </text>
            </Show>
            <div
              style={{
                ...row,
                justifyContent: "flex-start",
                flexGrow: 1,
                alignItems: "flex-end",
              }}
            >
              <Button
                testId="cancel"
                aria-label="Cancel"
                disabled={resolved()}
                onClick={() =>
                  act(async () => {
                    await props.controller.resolvePairingConfirmation(
                      false,
                      p.state.generation,
                    );
                    setCancelled(true);
                    setResolved(true);
                  })
                }
                style={{ ...button, opacity: resolved() ? 0.48 : 1 }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : route.kind === "pairingCode" ? (
          <div style={{ ...column, padding: 16, flexGrow: 1 }}>
            <Button
              testId="copy-pairing-code"
              aria-label="Copy pairing code"
              onClick={() => copy(route.model.pairingCode)}
              style={{
                ...button,
                position: "relative",
                height: "100%",
                minHeight: 112,
                flexGrow: 1,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: "#ffffff75",
                backgroundColor: "#f8f8f8",
                boxShadow: smallShadow,
                hover: { borderColor: "#4f8cff", backgroundColor: "#fafafb" },
              }}
            >
              <div
                style={{
                  ...row,
                  position: "absolute",
                  right: 14,
                  top: 14,
                  gap: 8,
                }}
              >
                <Show when={copied()}>
                  <text
                    style={{
                      color: "#ffffff",
                      backgroundColor: "#20242d",
                      fontSize: 11,
                      padding: 3,
                      borderRadius: 4,
                    }}
                  >
                    Copied
                  </text>
                </Show>
                <svg
                  source={icon("clipboard")}
                  style={{ width: 17, height: 17, color: "#20242d" }}
                />
              </div>
              <div style={{ ...row, gap: 5.04 }}>
                <For each={[...route.model.pairingCode]}>
                  {(digit) => (
                    <text
                      style={{
                        ...text,
                        fontFamily: mono,
                        fontSize: 42,
                        lineHeight: 63,
                        fontWeight: 850,
                      }}
                    >
                      {digit}
                    </text>
                  )}
                </For>
              </div>
            </Button>
          </div>
        ) : (
          <div style={{ ...row, flexGrow: 1, gap: 18, padding: 18 }}>
            <div
              style={{
                ...row,
                width: 168,
                height: 168,
                flexShrink: 0,
                justifyContent: "center",
                backgroundColor: "#ffffff",
                borderRadius: 12,
                borderWidth: 1,
                borderColor: "#ffffff75",
                boxShadow: smallShadow,
              }}
            >
              <Qr url={route.model.daemonUrl} />
            </div>
            <div
              style={{
                ...column,
                flexGrow: 1,
                flexBasis: 0,
                minWidth: 0,
                backgroundColor: "#ffffff",
                borderWidth: 1,
                borderColor: "#d8dde7",
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              <Property
                label="Daemon URL"
                value={route.model.daemonUrl}
                testId="daemon-url"
                actionId="copy-daemon-url"
                actionLabel={copied() ? "Daemon URL copied" : "Copy daemon URL"}
                image={copied() ? "check" : "clipboard"}
                action={() => copy(route.model.daemonUrl)}
              />
              <Property
                label="Config"
                value={route.model.configPath}
                testId="config-path"
                actionId="open-config"
                actionLabel="Open config"
                image="external"
                action={() => act(props.controller.openConfig)}
              />
            </div>
          </div>
        )}
      </div>
    );
  }
  function Property(p: {
    label: string;
    value: string;
    testId: string;
    actionId: string;
    actionLabel: string;
    image: "clipboard" | "check" | "external";
    action(): void;
  }) {
    return (
      <div style={column}>
        <text
          style={{
            color: "#667085",
            fontSize: 12,
            lineHeight: 18,
            fontWeight: 700,
            backgroundColor: "#fbfcfe",
            paddingLeft: 12,
            paddingRight: 12,
            paddingTop: 6,
            paddingBottom: 5,
            borderBottomWidth: 1,
            borderColor: "#d8dde7",
          }}
        >
          {p.label}
        </text>
        <div style={{ ...row, padding: 12, gap: 8 }}>
          <text
            testId={p.testId}
            style={{
              ...text,
              flexGrow: 1,
              flexBasis: 0,
              minWidth: 0,
              fontFamily: mono,
              lineHeight: 16.8,
              borderRadius: 3,
              borderWidth: 1,
              borderColor: "#d8dde7",
              backgroundColor: "#f4f6fa",
              paddingLeft: 6,
              paddingRight: 6,
            }}
          >
            {p.value}
          </text>
          <Button
            testId={p.actionId}
            aria-label={p.actionLabel}
            onClick={p.action}
            style={{ ...button, width: 34, height: 34, flexShrink: 0 }}
          >
            <svg
              source={icon(p.image)}
              style={{
                width: 15,
                height: 15,
                color: p.image === "check" ? "#4f8cff" : "#20242d",
              }}
            />
          </Button>
        </div>
      </div>
    );
  }

  function Qr(p: { url: string }) {
    let live = true;
    onCleanup(() => {
      live = false;
    });
    const mount = (element: HostElement) => {
      const url = new URL("https://rieul.app/");
      url.searchParams.set("daemonUrl", p.url);
      void QRCode.toBuffer(url.toString(), {
        width: 146,
        margin: 0,
        errorCorrectionLevel: "M",
        color: { dark: "#202632", light: "#ffffff" },
      })
        .then((bytes) => {
          if (live) renderer.setImage?.(element.id, bytes);
        })
        .catch((error) => setError(String(error)));
    };
    return (
      <img
        testId="daemon-qr"
        ref={mount}
        style={{
          width: 146,
          height: 146,
          flexShrink: 0,
          backgroundColor: "#ffffff",
        }}
      />
    );
  }
  return (
    <div
      style={{
        ...column,
        ...text,
        height: "100%",
        position: "relative",
        backgroundColor: "#f4f5f7",
        padding: 18,
      }}
    >
      <img
        ref={mountBackdrop}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />
      <div style={panel}>
        <Show when={state()} keyed>
          {(current) => <Screen state={current} />}
        </Show>
        <Show when={error()}>
          <text
            testId="error"
            style={{
              color: "#b42318",
              fontSize: 12,
              paddingLeft: 16,
              paddingRight: 16,
            }}
          >
            {error()}
          </text>
        </Show>
        <div
          style={{
            ...row,
            justifyContent: "flex-end",
            position: "absolute",
            right: 30,
            bottom: 22,
            gap: 8,
          }}
        >
          <Button
            testId="daemon-info"
            aria-label="Daemon info"
            onClick={() => act(props.controller.showDaemonInfo)}
            style={{ ...button, color: "#667085", fontSize: 11 }}
          >
            Daemon info
          </Button>
          <Button
            testId="hide"
            aria-label="Close"
            onClick={() => props.controller.close()}
            style={{ ...button, color: "#667085", fontSize: 11 }}
          >
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

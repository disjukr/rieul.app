import { createSignal, For, onCleanup, Show } from "solid-js";
import { Button, useGpuixRequired, type HostElement } from "@gpuix/solid";
import QRCode from "qrcode";
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
  const text = { color: "#263246", fontSize: 14 } as const;
  const button = {
    padding: 10,
    borderRadius: 8,
    backgroundColor: "#dce7f9",
    color: "#263246",
    cursor: "pointer",
  } as const;
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
    const select = (candidate: string) => {
      if (route.kind !== "confirmPairing" || resolved()) return;
      const accepted = candidate === route.model.confirmationCode;
      act(async () => {
        await props.controller.resolvePairingConfirmation(
          accepted,
          p.state.generation,
        );
        setResolved(true);
        setIncorrect(!accepted);
      });
    };
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          gap: 15,
        }}
      >
        <text
          testId="route-title"
          style={{ ...text, fontSize: 21, fontWeight: 700 }}
        >
          {route.kind === "confirmPairing"
            ? "Select the code shown on your client."
            : route.kind === "pairingCode"
              ? "Pairing code"
              : "Daemon info"}
        </text>
        {route.kind === "confirmPairing" ? (
          <>
            <text testId="client-label" style={text}>
              {route.model.clientLabel.trim() || "Unknown client"}
            </text>
            <text
              style={text}
            >{`Wants to connect to daemon → ${route.model.daemonUrl}`}</text>
            <div style={{ display: "flex", flexDirection: "row", gap: 12 }}>
              <For each={route.model.candidates}>
                {(candidate) => (
                  <Button
                    testId={`candidate-${candidate}`}
                    disabled={resolved()}
                    onClick={() => select(candidate)}
                    style={{ ...button, flexGrow: 1, height: 64, fontSize: 28 }}
                  >
                    {candidate}
                  </Button>
                )}
              </For>
            </div>
            <Show when={incorrect()}>
              <text
                testId="incorrect"
                style={{ color: "#af293b", fontSize: 13 }}
              >
                That code did not match. Please start pairing again from the
                client.
              </text>
            </Show>
            <Show when={resolved() && !incorrect()}>
              <text testId="accepted" style={text}>
                Confirmation sent.
              </text>
            </Show>
            <Button
              testId="cancel"
              disabled={resolved()}
              onClick={() =>
                act(async () => {
                  await props.controller.resolvePairingConfirmation(
                    false,
                    p.state.generation,
                  );
                  setResolved(true);
                })
              }
              style={button}
            >
              Cancel
            </Button>
          </>
        ) : route.kind === "pairingCode" ? (
          <>
            <text testId="expiry" style={text}>{`${Math.floor(remaining() / 60)
              .toString()
              .padStart(
                2,
                "0",
              )}:${(remaining() % 60).toString().padStart(2, "0")}`}</text>
            <Button
              testId="copy-pairing-code"
              onClick={() => copy(route.model.pairingCode)}
              style={{ ...button, height: 100, fontSize: 38 }}
            >
              {route.model.pairingCode}
            </Button>
          </>
        ) : (
          <div style={{ display: "flex", flexDirection: "row", gap: 18 }}>
            <Qr url={route.model.daemonUrl} />
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
                flexGrow: 1,
                flexBasis: 0,
                minWidth: 0,
              }}
            >
              <text style={text}>Daemon URL</text>
              <text testId="daemon-url" style={text}>
                {route.model.daemonUrl}
              </text>
              <Button
                testId="copy-daemon-url"
                onClick={() => copy(route.model.daemonUrl)}
                style={button}
              >
                Copy daemon URL
              </Button>
              <text
                testId="config-path"
                style={{
                  ...text,
                  fontSize: 11,
                  whiteSpace: "nowrap",
                  textOverflow: "ellipsis",
                }}
              >
                {route.model.configPath}
              </text>
              <Button
                testId="open-config"
                onClick={() => act(props.controller.openConfig)}
                style={button}
              >
                Open config
              </Button>
            </div>
          </div>
        )}
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
        width: 154,
        margin: 0,
        errorCorrectionLevel: "M",
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
          width: 154,
          height: 154,
          flexShrink: 0,
          backgroundColor: "#ffffff",
        }}
      />
    );
  }
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#eef3fa",
        padding: 24,
        gap: 14,
      }}
    >
      <Show when={state()} keyed>
        {(current) => <Screen state={current} />}
      </Show>
      <Show when={copied()}>
        <text style={text}>Copied</text>
      </Show>
      <Show when={error()}>
        <text testId="error" style={{ color: "#af293b", fontSize: 12 }}>
          {error()}
        </text>
      </Show>
      <div style={{ display: "flex", flexDirection: "row", gap: 8 }}>
        <Button
          testId="daemon-info"
          onClick={() => act(props.controller.showDaemonInfo)}
          style={button}
        >
          Daemon info
        </Button>
        <Button
          testId="hide"
          onClick={() => props.controller.close()}
          style={button}
        >
          Close
        </Button>
      </div>
    </div>
  );
}

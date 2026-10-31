import { override } from "bunja";
import { atom, createStore } from "jotai/vanilla";
import { createSignal, Show } from "solid-js";
import { render } from "@solidjs/web";
import { BunjaProvider } from "../../src/solid/bunja.tsx";
import { JotaiProvider } from "../../src/solid/jotai.tsx";
import { FsEntryKind } from "../../src/protocol/generated/rpc.ts";
import { type Machine } from "../../src/state/machines.ts";
import { FilesActionsContext } from "../../src/view/workbench/tool/files/context.tsx";
import { fileViewerBunja } from "../../src/view/workbench/tool/files/content/file-viewer/state.tsx";
import type { FileViewerImplId } from "../../src/view/workbench/tool/files/content/file-viewer/impl/index.ts";
import ImageFileViewer from "../../src/view/workbench/tool/files/content/file-viewer/impl/image/index.tsx";
import PdfFileViewer from "../../src/view/workbench/tool/files/content/file-viewer/impl/pdf/index.tsx";

const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);
// A real one-page PDF, with offsets computed from the ASCII document.
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << >> >>",
  "<< /Length 23 >>\nstream\n0 0 1 rg 0 0 50 50 re f\nendstream",
];
let document = "%PDF-1.4\n";
const offsets = [0];
for (const [index, object] of objects.entries()) {
  offsets.push(document.length);
  document += `${index + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = document.length;
document += `xref\n0 5\n0000000000 65535 f \n${offsets
  .slice(1)
  .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
  .join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const pdf = new TextEncoder().encode(document);
type ViewerState =
  | { phase: "detecting" }
  | { phase: "error"; message: string }
  | { phase: "ready"; initialBytes: Uint8Array; impl: FileViewerImplId };
const machineAtom = atom<Machine | undefined>({
  id: "fixture",
  name: "Fixture",
  baseUrl: "https://fixture.invalid",
});
const imageModel = {
  fsEntry: {
    kind: FsEntryKind.File,
    name: "fixture.png",
    path: "/fixture.png",
    size: png.length,
    readonly: true,
  },
  implAtom: atom<FileViewerImplId | undefined>("image"),
  stateAtom: atom<ViewerState>({
    phase: "ready",
    initialBytes: png,
    impl: "image",
  }),
  machineAtom,
  tabId: "image",
  webTransport: async (): Promise<WebTransport> => {
    throw new Error("Fixture must use complete initial bytes");
  },
};
const pdfModel = {
  fsEntry: {
    kind: FsEntryKind.File,
    name: "fixture.pdf",
    path: "/fixture.pdf",
    size: pdf.length,
    readonly: true,
  },
  implAtom: atom<FileViewerImplId | undefined>("pdf"),
  stateAtom: atom<ViewerState>({
    phase: "ready",
    initialBytes: pdf,
    impl: "pdf",
  }),
  machineAtom,
  tabId: "pdf",
  webTransport: imageModel.webTransport,
};
const urls = { created: [] as string[], revoked: [] as string[] };
const createUrl = URL.createObjectURL.bind(URL);
const revokeUrl = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (blob) => {
  const url = createUrl(blob);
  urls.created.push(url);
  return url;
};
URL.revokeObjectURL = (url) => {
  urls.revoked.push(url);
  revokeUrl(url);
};
Object.assign(window, { fileResources: urls });
const actions = {
  goBack() {},
  goUp() {},
  navigate() {},
  openEntry() {},
  openEntryMenu() {},
  openFolderMenu() {},
  selectEntry() {},
};
const store = createStore();
function Fixture() {
  const [mode, setMode] = createSignal<"image" | "pdf" | undefined>();
  return (
    <>
      <button onClick={() => setMode("image")}>Show image</button>
      <button onClick={() => setMode("pdf")}>Show PDF</button>
      <button onClick={() => setMode(undefined)}>Remove viewer</button>
      <JotaiProvider store={store}>
        <FilesActionsContext value={() => actions}>
          <Show when={mode() === "image"}>
            <BunjaProvider
              overrides={[override(fileViewerBunja, () => imageModel)]}
            >
              <ImageFileViewer />
            </BunjaProvider>
          </Show>
          <Show when={mode() === "pdf"}>
            <BunjaProvider
              overrides={[override(fileViewerBunja, () => pdfModel)]}
            >
              <PdfFileViewer />
            </BunjaProvider>
          </Show>
        </FilesActionsContext>
      </JotaiProvider>
    </>
  );
}
render(() => <Fixture />, globalThis.document.getElementById("root")!);

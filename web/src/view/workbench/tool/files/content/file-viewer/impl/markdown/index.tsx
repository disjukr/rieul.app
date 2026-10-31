import { createMemo, createSignal, createEffect, useContext } from "solid-js";
import { marked } from "marked";
import { useBunja } from "../../../../../../../../solid/bunja.tsx";
import { useAtomValue } from "../../../../../../../../solid/jotai.tsx";
import type { FsEntry } from "../../../../../../../../protocol/generated/rpc.ts";
import { readFileBytes } from "../../read-file-bytes.ts";
import {
  FilesActionsContext,
  requireFilesActions,
} from "../../../../context.tsx";
import { BigFileWarning } from "../../big-file-warning.tsx";
import { fileViewerBunja } from "../../state.tsx";
const inlineOpenLimitBytes = 1024 * 1024;
const fileViewerStatusClassName = [
  "flex items-center justify-center gap-[8px] min-w-0 min-h-0",
  "text-[#667085] text-[14px]",
  "[&.error]:items-start [&.error]:justify-start [&.error]:overflow-auto",
  "[&.error]:text-[#b42318] [&.error]:p-[14px]",
].join(" ");
const markdownContentClassName = [
  "markdown-viewer min-w-0 min-h-0 overflow-auto bg-white",
  "px-[28px] py-[22px] text-[#20242d] text-[15px] leading-[1.65]",
  "[&_>*:first-child]:mt-0 [&_>*:last-child]:mb-0",
  "[&_a]:text-[#2f6edc] [&_a]:font-650 [&_a]:underline",
  "[&_blockquote]:m-0 [&_blockquote]:my-[14px] [&_blockquote]:border-l-[3px]",
  "[&_blockquote]:border-l-[#cfd7e5] [&_blockquote]:pl-[14px]",
  "[&_blockquote]:text-[#475467]",
  "[&_code]:rounded-[4px] [&_code]:bg-[#eef2f7] [&_code]:px-[4px]",
  "[&_code]:py-[1px] [&_code]:font-mono [&_code]:text-[14px]",
  "[&_pre]:my-[14px] [&_pre]:overflow-auto [&_pre]:rounded-[6px]",
  "[&_pre]:bg-[#101828] [&_pre]:p-[14px] [&_pre]:text-[#f2f4f7]",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit",
  "[&_h1]:mb-[12px] [&_h1]:mt-[4px] [&_h1]:border-b",
  "[&_h1]:border-b-[#d8dde7] [&_h1]:pb-[8px] [&_h1]:text-[24px]",
  "[&_h1]:leading-[1.25]",
  "[&_h2]:mb-[10px] [&_h2]:mt-[20px] [&_h2]:text-[19px]",
  "[&_h2]:leading-[1.3]",
  "[&_h3]:mb-[8px] [&_h3]:mt-[16px] [&_h3]:text-[16px]",
  "[&_hr]:my-[18px] [&_hr]:border-0 [&_hr]:border-t",
  "[&_hr]:border-t-[#d8dde7]",
  "[&_li]:my-[4px] [&_ol]:pl-[24px] [&_ul]:pl-[24px]",
  "[&_p]:my-[11px]",
  "[&_table]:my-[14px] [&_table]:border-collapse [&_table]:text-[14px]",
  "[&_td]:border [&_td]:border-[#d8dde7] [&_td]:px-[8px] [&_td]:py-[6px]",
  "[&_th]:border [&_th]:border-[#d8dde7] [&_th]:bg-[#fbfcfe]",
  "[&_th]:px-[8px] [&_th]:py-[6px] [&_th]:text-left",
].join(" ");
type MarkdownReadState =
  | {
      phase: "loading";
    }
  | {
      phase: "ready";
      text: string;
    }
  | {
      phase: "error";
      message: string;
    };
const allowedMarkdownTags = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);
const removedMarkdownTags = new Set([
  "iframe",
  "link",
  "meta",
  "object",
  "script",
  "style",
]);
const markdownViewerName = "markdown viewer";
export default function MarkdownFileViewer() {
  const actions = requireFilesActions(useContext(FilesActionsContext));
  const viewer = useBunja(fileViewerBunja);
  const fsEntry = createMemo(() => viewer().fsEntry);
  const viewerState = useAtomValue(() => viewer().stateAtom);
  const machine = useAtomValue(() => viewer().machineAtom);
  const webTransport = createMemo(() => viewer().webTransport);
  const requiresConfirmation = createMemo(() => {
    const size = fsEntry().size;
    return size === undefined || size > inlineOpenLimitBytes;
  });
  const [confirmedFsEntryPath, setConfirmedFsEntryPath] = createSignal<
    string | undefined
  >();
  const confirmed = createMemo(
    () => !requiresConfirmation() || confirmedFsEntryPath() === fsEntry().path,
  );
  const [state, setState] = createSignal<MarkdownReadState>({
    phase: "loading",
  });
  const errorMessage = createMemo(() => {
    const value = state();
    return value.phase === "error" ? value.message : "";
  });

  const html = createMemo(() => {
    const current = state();
    return current.phase === "ready" ? renderMarkdown(current.text) : "";
  });
  createEffect(
    () => ({
      confirmed: confirmed(),
      machine: machine(),
      viewerState: viewerState(),
      fsEntry: fsEntry(),
      webTransport: webTransport(),
    }),
    ({
      confirmed: currentConfirmed,
      machine: currentMachine,
      viewerState: currentViewerState,
      fsEntry: currentFsEntry,
      webTransport: currentWebTransport,
    }) => {
      if (
        !currentConfirmed ||
        !currentMachine ||
        currentViewerState.phase !== "ready"
      )
        return;
      let cancelled = false;
      setState({ phase: "loading" });
      void (async () => {
        try {
          const bytes = hasCompleteInitialBytes(
            currentFsEntry,
            currentViewerState.initialBytes,
          )
            ? currentViewerState.initialBytes
            : await readFileBytes(
                await currentWebTransport(),
                currentFsEntry.path,
              );
          if (cancelled) return;
          setState({
            phase: "ready",
            text: decodeMarkdownFile(bytes),
          });
        } catch (err) {
          if (!cancelled) {
            setState({
              phase: "error",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    },
  );
  return (
    <>
      {!machine() ? (
        <div class={`${fileViewerStatusClassName} error`}>
          <span>No machine selected</span>
        </div>
      ) : viewerState().phase !== "ready" ? null : !confirmed() ? (
        <BigFileWarning
          onCancel={actions().goBack}
          onConfirm={() => setConfirmedFsEntryPath(fsEntry().path)}
          viewerName={markdownViewerName}
        />
      ) : state().phase === "loading" ? (
        <div class={fileViewerStatusClassName}>
          <span>Loading markdown</span>
        </div>
      ) : state().phase === "error" ? (
        <div class={`${fileViewerStatusClassName} error`}>
          <span>{errorMessage()}</span>
        </div>
      ) : (
        <article class={markdownContentClassName} innerHTML={html()} />
      )}
    </>
  );
}
function hasCompleteInitialBytes(
  fsEntry: FsEntry,
  initialBytes: Uint8Array,
): boolean {
  return fsEntry.size !== undefined && fsEntry.size <= initialBytes.byteLength;
}
function decodeMarkdownFile(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false });
  if (typeof html !== "string") {
    throw new Error("Markdown parser returned an async result.");
  }
  return sanitizeMarkdownHtml(html);
}
function sanitizeMarkdownHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  sanitizeMarkdownChildren(template.content);
  return template.innerHTML;
}
function sanitizeMarkdownChildren(parent: Node) {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.COMMENT_NODE) {
      child.remove();
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    const tagName = element.tagName.toLowerCase();
    if (removedMarkdownTags.has(tagName)) {
      element.remove();
      continue;
    }
    sanitizeMarkdownChildren(element);
    if (!allowedMarkdownTags.has(tagName)) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }
    sanitizeMarkdownAttributes(element, tagName);
  }
}
function sanitizeMarkdownAttributes(element: Element, tagName: string) {
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.name === "href" && tagName === "a") {
      if (isSafeMarkdownUrl(attribute.value)) continue;
    }
    element.removeAttribute(attribute.name);
  }
  if (tagName === "a" && element.hasAttribute("href")) {
    element.setAttribute("target", "_blank");
    element.setAttribute("rel", "noreferrer noopener");
  }
}
function isSafeMarkdownUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return true;
  try {
    const url = new URL(trimmed, globalThis.location.href);
    return (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "mailto:"
    );
  } catch {
    return false;
  }
}

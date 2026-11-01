import { style } from "../../../../../../../../zyzz.config.ts";
import { createMemo, createSignal, createEffect, useContext } from "solid-js";
import { marked } from "marked";
import { useBunja } from "bunja/solid";

import type { FsEntry } from "../../../../../../../../protocol/generated/rpc.ts";
import { readFileBytes } from "../../read-file-bytes.ts";
import {
  FilesActionsContext,
  requireFilesActions,
} from "../../../../context.tsx";
import { BigFileWarning } from "../../big-file-warning.tsx";
import { fileViewerBunja } from "../../state.tsx";
const inlineOpenLimitBytes = 1024 * 1024;

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
  const viewerState = () => viewer().state();
  const machine = () => viewer().machine();
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
        <div class={`${styles.fileViewerStatus().class} error`}>
          <span>No machine selected</span>
        </div>
      ) : viewerState().phase !== "ready" ? null : !confirmed() ? (
        <BigFileWarning
          onCancel={actions().goBack}
          onConfirm={() => setConfirmedFsEntryPath(fsEntry().path)}
          viewerName={markdownViewerName}
        />
      ) : state().phase === "loading" ? (
        <div {...styles.fileViewerStatus()}>
          <span>Loading markdown</span>
        </div>
      ) : state().phase === "error" ? (
        <div class={`${styles.fileViewerStatus().class} error`}>
          <span>{errorMessage()}</span>
        </div>
      ) : (
        <article
          {...styles.markdownContent({ className: "markdown-viewer" })}
          innerHTML={html()}
        />
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

namespace styles {
  export const fileViewerStatus = style({
    minHeight: "0",
    minWidth: "0",
    display: "flex",
    selectors: {
      "&.error": {
        alignItems: "flex-start",
        justifyContent: "flex-start",
        overflow: "auto",
        padding: "14px",
        color: "rgb(180 35 24 / 1)",
      },
    },
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    fontSize: "14px",
    color: "rgb(102 112 133 / 1)",
  });
  export const markdownContent = style({
    selectors: {
      "& blockquote": {
        margin: "0",
        marginTop: "14px",
        marginBottom: "14px",
        borderLeftWidth: "3px",
        borderLeftColor: "rgb(207 215 229 / 1)",
        paddingLeft: "14px",
        color: "rgb(71 84 103 / 1)",
      },
      "& pre": {
        marginTop: "14px",
        marginBottom: "14px",
        overflow: "auto",
        borderRadius: "6px",
        backgroundColor: "rgb(16 24 40 / 1)",
        padding: "14px",
        color: "rgb(242 244 247 / 1)",
      },
      "& table": {
        marginTop: "14px",
        marginBottom: "14px",
        borderCollapse: "collapse",
        fontSize: "14px",
      },
      "& hr": {
        marginTop: "18px",
        marginBottom: "18px",
        borderWidth: "0px",
        borderTopWidth: "1px",
        borderTopColor: "rgb(216 221 231 / 1)",
      },
      "& li": {
        marginTop: "4px",
        marginBottom: "4px",
      },
      "& p": {
        marginTop: "11px",
        marginBottom: "11px",
      },
      "& >*:first-child": {
        marginTop: "0",
      },
      "& >*:last-child": {
        marginBottom: "0",
      },
      "& h1": {
        marginBottom: "12px",
        marginTop: "4px",
        borderBottomWidth: "1px",
        borderBottomColor: "rgb(216 221 231 / 1)",
        paddingBottom: "8px",
        fontSize: "24px",
        lineHeight: 1.25,
      },
      "& h2": {
        marginBottom: "10px",
        marginTop: "20px",
        fontSize: "19px",
        lineHeight: 1.3,
      },
      "& h3": {
        marginBottom: "8px",
        marginTop: "16px",
        fontSize: "16px",
      },
      "& td": {
        borderWidth: "1px",
        borderColor: "rgb(216 221 231 / 1)",
        paddingLeft: "8px",
        paddingRight: "8px",
        paddingTop: "6px",
        paddingBottom: "6px",
      },
      "& th": {
        borderWidth: "1px",
        borderColor: "rgb(216 221 231 / 1)",
        backgroundColor: "rgb(251 252 254 / 1)",
        paddingLeft: "8px",
        paddingRight: "8px",
        paddingTop: "6px",
        paddingBottom: "6px",
        textAlign: "left",
      },
      "& code": {
        borderRadius: "4px",
        backgroundColor: "rgb(238 242 247 / 1)",
        paddingLeft: "4px",
        paddingRight: "4px",
        paddingTop: "1px",
        paddingBottom: "1px",
        fontSize: "14px",
        fontFamily:
          'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace',
      },
      "& pre code": {
        backgroundColor: "transparent",
        padding: "0",
        color: "inherit",
      },
      "& ol": {
        paddingLeft: "24px",
      },
      "& ul": {
        paddingLeft: "24px",
      },
      "& a": {
        color: "rgb(47 110 220 / 1)",
        fontWeight: 650,
        textDecorationLine: "underline",
      },
    },
    minHeight: "0",
    minWidth: "0",
    overflow: "auto",
    backgroundColor: "rgb(255 255 255 / 1)",
    paddingLeft: "28px",
    paddingRight: "28px",
    paddingTop: "22px",
    paddingBottom: "22px",
    fontSize: "15px",
    color: "rgb(32 36 45 / 1)",
    lineHeight: 1.65,
  });
}

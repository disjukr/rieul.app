import { createEffect, untrack } from "solid-js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.main.js";
interface MonacoTextViewerProps {
  onChange: (text: string) => void;
  onSave: (text: string) => void;
  path: string;
  text: string;
}
const monacoTextViewerClassName =
  "w-full h-full min-w-0 min-h-0 overflow-hidden";
const monacoHost = globalThis as typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: (_moduleId: string, label: string) => Worker;
  };
};
monacoHost.MonacoEnvironment ??= {
  getWorker: (_moduleId, label) => {
    switch (label) {
      case "css":
      case "less":
      case "scss":
        return new Worker(new URL("./workers/css.worker.ts", import.meta.url), {
          type: "module",
        });
      case "handlebars":
      case "html":
      case "razor":
        return new Worker(
          new URL("./workers/html.worker.ts", import.meta.url),
          { type: "module" },
        );
      case "javascript":
      case "typescript":
        return new Worker(new URL("./workers/ts.worker.ts", import.meta.url), {
          type: "module",
        });
      case "json":
        return new Worker(
          new URL("./workers/json.worker.ts", import.meta.url),
          { type: "module" },
        );
      default:
        return new Worker(
          new URL("./workers/editor.worker.ts", import.meta.url),
          { type: "module" },
        );
    }
  },
};
export function MonacoTextViewer(props: MonacoTextViewerProps) {
  const hostRef = { current: null as HTMLDivElement | null };
  const onChangeRef = { current: untrack(() => props.onChange) };
  const onSaveRef = { current: untrack(() => props.onSave) };
  const editorRef = {
    current: undefined as monaco.editor.IStandaloneCodeEditor | undefined,
  };
  const modelRef = {
    current: undefined as monaco.editor.ITextModel | undefined,
  };
  createEffect(
    () => props.onChange,
    (currentOnChange) => {
      onChangeRef.current = currentOnChange;
    },
  );
  createEffect(
    () => props.onSave,
    (currentOnSave) => {
      onSaveRef.current = currentOnSave;
    },
  );
  createEffect(
    () => undefined,
    () => {
      const currentText = untrack(() => props.text);
      const currentPath = untrack(() => props.path);
      const host = hostRef.current;
      if (!host) return;
      const model = monaco.editor.createModel(
        currentText,
        languageFromPath(currentPath),
      );
      const editor = monaco.editor.create(host, {
        automaticLayout: true,
        contextmenu: true,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 12,
        lineHeight: 19,
        minimap: { enabled: false },
        model,
        renderLineHighlight: "none",
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        stickyScroll: { enabled: false },
        wordWrap: "off",
      });
      const changeDisposable = model.onDidChangeContent(() => {
        onChangeRef.current(model.getValue());
      });
      const saveDisposable = editor.onKeyDown((event) => {
        const keyS = event.browserEvent.key.toLowerCase() === "s";
        if (!keyS || !(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        event.stopPropagation();
        onSaveRef.current(model.getValue());
      });
      editorRef.current = editor;
      modelRef.current = model;
      return () => {
        changeDisposable.dispose();
        saveDisposable.dispose();
        editor.dispose();
        model.dispose();
        editorRef.current = undefined;
        modelRef.current = undefined;
      };
    },
  );
  createEffect(
    () => props.text,
    (currentText) => {
      const model = modelRef.current;
      if (!model || model.getValue() === currentText) return;
      model.setValue(currentText);
    },
  );
  createEffect(
    () => props.path,
    (currentPath) => {
      const model = modelRef.current;
      if (!model) return;
      monaco.editor.setModelLanguage(model, languageFromPath(currentPath));
    },
  );
  return (
    <div
      ref={(element) => (hostRef.current = element)}
      class={monacoTextViewerClassName}
    />
  );
}
function languageFromPath(path: string): string {
  const basename = fileBasename(path).toLowerCase();
  if (basename === "dockerfile") return "dockerfile";
  if (basename === "makefile") return "makefile";
  const extension = fileExtension(basename);
  switch (extension) {
    case "c":
    case "h":
      return "c";
    case "cmd":
    case "bat":
      return "bat";
    case "cpp":
    case "hpp":
      return "cpp";
    case "cs":
      return "csharp";
    case "css":
      return "css";
    case "go":
      return "go";
    case "html":
      return "html";
    case "java":
      return "java";
    case "js":
    case "mjs":
      return "javascript";
    case "json":
      return "json";
    case "jsx":
      return "javascript";
    case "kt":
      return "kotlin";
    case "md":
      return "markdown";
    case "ps1":
      return "powershell";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "sh":
      return "shell";
    case "sql":
      return "sql";
    case "svg":
    case "xml":
      return "xml";
    case "toml":
      return "toml";
    case "ts":
      return "typescript";
    case "tsx":
      return "typescript";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return "plaintext";
  }
}
function fileBasename(path: string): string {
  const slashIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(slashIndex + 1);
}
function fileExtension(basename: string): string | undefined {
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === basename.length - 1) return undefined;
  return basename.slice(dotIndex + 1);
}

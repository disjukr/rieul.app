import { createSignal, Show } from "solid-js";
import { render } from "@solidjs/web";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { MonacoTextViewer } from "../../src/view/workbench/tool/files/content/file-viewer/impl/text/monaco-text-viewer.tsx";
Object.assign(window, {
  editorFixture: {
    models: () =>
      monaco.editor.getModels().map((model) => ({
        id: model.id,
        text: model.getValue(),
        language: model.getLanguageId(),
      })),
    edit: (text: string) => monaco.editor.getModels()[0].setValue(text),
  },
});
function Fixture() {
  const [text, setText] = createSignal("initial");
  const [path, setPath] = createSignal("fixture.txt");
  const [shown, setShown] = createSignal(true);
  return (
    <>
      <button onClick={() => setText("external update")}>Replace text</button>
      <button onClick={() => setPath("fixture.json")}>Replace path</button>
      <button onClick={() => setShown(false)}>Remove editor</button>
      <output aria-label="draft">{text()}</output>
      <div style={{ width: "640px", height: "400px" }}>
        <Show when={shown()}>
          <MonacoTextViewer
            text={text()}
            path={path()}
            onChange={setText}
            onSave={setText}
          />
        </Show>
      </div>
    </>
  );
}
render(() => <Fixture />, document.getElementById("root")!);

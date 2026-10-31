import { createSignal, Show } from "solid-js";
import { render } from "@solidjs/web";
import { AppTooltip } from "../../src/view/ui/tooltip.tsx";
import { ModalDialog } from "../../src/view/ui/dialog.tsx";
import {
  FloatingMenu,
  FloatingMenuItem,
  useFloatingMenuDismiss,
} from "../../src/view/ui/floating-menu.tsx";
import { FileTable } from "../../src/view/workbench/tool/files/content/directory/file-table.tsx";
import { PathCrumbs } from "../../src/view/workbench/tool/files/navbar/path-crumbs.tsx";
import { FsEntryKind } from "../../src/protocol/generated/rpc.ts";
function Fixture() {
  const [dialog, setDialog] = createSignal(false);
  const [menu, setMenu] = createSignal(false);
  const [action, setAction] = createSignal("");
  const menuRef = { current: null as HTMLDivElement | null };
  const anchorRef = { current: null as HTMLButtonElement | null };
  useFloatingMenuDismiss(menu, menuRef, () => setMenu(false));
  const [rename, setRename] = createSignal<string>();
  const [draft, setDraft] = createSignal("original.txt");
  const [path, setPath] = createSignal<string | undefined>("/initial");
  const row = {
    path: "/original.txt",
    name: "original.txt",
    kind: FsEntryKind.File,
    readonly: false,
  };
  return (
    <>
      <span id="existing-description" hidden>
        Existing description
      </span>
      <AppTooltip label="Fixture tooltip">
        <button aria-describedby="existing-description">Tooltip trigger</button>
      </AppTooltip>
      <button onClick={() => setDialog(true)}>Open dialog</button>
      <button
        ref={(element) => (anchorRef.current = element)}
        onClick={() => setMenu(true)}
      >
        Open menu
      </button>
      <output aria-label="action">{action()}</output>
      <Show when={dialog()}>
        <ModalDialog
          title="Fixture dialog"
          titleId="fixture-title"
          onClose={() => setDialog(false)}
        >
          <input aria-label="Dialog input" />
          <button>Last dialog button</button>
        </ModalDialog>
      </Show>
      <Show when={menu()}>
        <FloatingMenu menuRef={menuRef} anchorRef={anchorRef}>
          <FloatingMenuItem
            onClick={() => {
              setAction("Alpha");
              setMenu(false);
            }}
          >
            Alpha
          </FloatingMenuItem>
          <FloatingMenuItem disabled>Disabled</FloatingMenuItem>
          <FloatingMenuItem
            onClick={() => {
              setAction("Beta");
              setMenu(false);
            }}
          >
            Beta
          </FloatingMenuItem>
        </FloatingMenu>
      </Show>
      <button onClick={() => setRename(row.path)}>Rename file</button>
      <FileTable
        rows={[row]}
        createDraftName=""
        createIsCreating={false}
        createIsEditing={false}
        onCreateCancel={() => {}}
        onCreateCommit={() => {}}
        onCreateDraftChange={() => {}}
        onSelect={() => {}}
        onOpen={() => {}}
        onContextMenu={() => {}}
        onFolderContextMenu={() => {}}
        renameDraftName={draft()}
        renameIsSaving={false}
        renamingPath={rename()}
        onRenameCancel={() => setRename(undefined)}
        onRenameCommit={() => {
          setAction(draft());
          setRename(undefined);
        }}
        onRenameDraftChange={setDraft}
      />
      <div style={{ width: "400px" }}>
        <PathCrumbs path={path()} onNavigate={setPath} />
      </div>
      <output aria-label="current path">{path()}</output>
    </>
  );
}
render(() => <Fixture />, document.getElementById("root")!);

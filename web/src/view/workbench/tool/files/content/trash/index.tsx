import { useEffect, useState } from "react";
import { useBunja } from "bunja/react";
import { RotateCcw, Trash2 } from "lucide-react";
import {
  purgeTrashItems,
  restoreTrashItems,
  subscribeTrashItems,
  type TrashItem,
  type TrashItemsTableEvent,
} from "../../../../../../protocol/rpc.ts";
import { formatDate, formatSize } from "../../../../../../state/explorer.ts";
import { rpcSessionBunja } from "../../../../../../state/rpc-session.ts";
import {
  clampFloatingMenuPosition,
  FloatingMenu,
  FloatingMenuItem,
} from "../../../../../ui/floating-menu.tsx";
import { className } from "../../../../../class-name.ts";

type TrashItemsState =
  | { phase: "connecting"; items: TrashItem[]; message?: string }
  | { phase: "live"; items: TrashItem[]; message?: string }
  | { phase: "error"; items: TrashItem[]; message: string }
  | { phase: "closed"; items: TrashItem[]; message: string };

interface TrashItemMenuState {
  item: TrashItem;
  x: number;
  y: number;
}

const trashContentClassName = [
  "grid [grid-template-rows:minmax(0,1fr)_auto]",
  "w-full h-full min-w-0 min-h-0 overflow-hidden bg-white",
].join(" ");
const trashTableClassName = [
  "grid min-h-0 min-w-0 overflow-auto",
  "[grid-template-columns:minmax(180px,1.2fr)_minmax(180px,1.4fr)_minmax(100px,140px)_minmax(140px,190px)]",
  "auto-rows-[2em] bg-white leading-[1.6]",
].join(" ");
const trashHeadClassName = [
  "sticky top-0 z-[1] flex h-[2rem] items-center box-border",
  "border-b border-b-[#d8dde7] bg-[#f6f8fb] px-[8px]",
  "text-[#667085] font-700",
].join(" ");
const trashRowClassName = [
  "grid [grid-column:1/-1] [grid-template-columns:subgrid]",
  "h-[2em] min-h-[2em] box-border border-0 border-b border-b-[#eef1f5]",
  "cursor-default bg-white text-left leading-[1.6] hover:bg-[#f7faff]",
  "[&.selected]:bg-[#eaf3ff]",
].join(" ");
const trashCellClassName = [
  "flex items-center min-w-0 overflow-hidden px-[8px]",
  "text-[#303642] text-ellipsis whitespace-nowrap",
].join(" ");
const trashMetaCellClassName = `${trashCellClassName} text-[#667085]`;
const trashFooterClassName = [
  "flex h-[2rem] min-h-[2rem] items-center justify-end box-border",
  "border-t border-t-[#d8dde7] bg-[#fbfcfe] px-[8px]",
  "text-[#667085] leading-[1.6]",
].join(" ");
const trashStatusClassName =
  "[grid-column:1/-1] flex items-center px-[12px] text-[#667085]";
const trashErrorClassName =
  "[grid-column:1/-1] flex items-center px-[12px] text-[#b42318]";
const trashContextMenuWidth = 176;

export function TrashContent() {
  const rpcSession = useBunja(rpcSessionBunja);
  const [state, setState] = useState<TrashItemsState>({
    phase: "connecting",
    items: [],
    message: "Opening trash",
  });
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const [itemMenu, setItemMenu] = useState<TrashItemMenuState>();

  useEffect(() => {
    let cancelled = false;
    let iterator: AsyncGenerator<TrashItemsTableEvent> | undefined;

    setState({ phase: "connecting", items: [], message: "Opening trash" });
    void (async () => {
      try {
        const transport = await rpcSession.webTransport();
        if (cancelled) return;
        iterator = subscribeTrashItems(transport);
        for await (const event of iterator) {
          if (cancelled) break;
          setState((current) => applyTrashItemsEvent(current.items, event));
        }
      } catch (err) {
        if (!cancelled) {
          setState((current) => ({
            phase: "error",
            items: current.items,
            message: err instanceof Error ? err.message : String(err),
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
      void iterator?.return(undefined);
    };
  }, [rpcSession]);

  useEffect(() => {
    if (!itemMenu) return;

    function closeMenu() {
      setItemMenu(undefined);
    }

    function closeMenuOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenu();
    }

    globalThis.addEventListener("mousedown", closeMenu);
    globalThis.addEventListener("keydown", closeMenuOnEscape);
    return () => {
      globalThis.removeEventListener("mousedown", closeMenu);
      globalThis.removeEventListener("keydown", closeMenuOnEscape);
    };
  }, [itemMenu]);

  function openItemMenu(
    item: TrashItem,
    event: React.MouseEvent<HTMLDivElement>,
  ) {
    event.preventDefault();
    event.stopPropagation();
    setSelectedItemId(item.id);
    setItemMenu({
      item,
      ...trashItemMenuPosition(event.clientX, event.clientY),
    });
  }

  async function restoreItem(item: TrashItem) {
    setItemMenu(undefined);
    await mutateTrashItem(item.id, restoreTrashItems, "Restore failed");
  }

  async function purgeItem(item: TrashItem) {
    setItemMenu(undefined);
    await mutateTrashItem(item.id, purgeTrashItems, "Permanent delete failed");
  }

  async function mutateTrashItem(
    itemId: string,
    mutate: (transport: WebTransport, itemIds: string[]) => Promise<{
      results: { ok: boolean; message?: string; code?: string }[];
    }>,
    fallbackMessage: string,
  ) {
    try {
      const transport = await rpcSession.webTransport();
      const result = await mutate(transport, [itemId]);
      const failure = result.results.find((item) => !item.ok);
      if (failure && !failure.ok) {
        setState((current) => ({
          phase: "error",
          items: current.items,
          message: failure.message || failure.code || fallbackMessage,
        }));
      }
    } catch (err) {
      setState((current) => ({
        phase: "error",
        items: current.items,
        message: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  const sortedItems = sortTrashItems(state.items);

  return (
    <section className={trashContentClassName}>
      <div className={trashTableClassName} role="grid" aria-label="Trash">
        <div className={trashHeadClassName}>Name</div>
        <div className={trashHeadClassName}>Original parent</div>
        <div className={trashHeadClassName}>Size</div>
        <div className={trashHeadClassName}>Deleted</div>
        {state.phase === "connecting"
          ? <div className={trashStatusClassName}>Opening trash</div>
          : state.phase === "error"
          ? <div className={trashErrorClassName}>{state.message}</div>
          : sortedItems.length === 0
          ? <div className={trashStatusClassName}>Trash is empty</div>
          : sortedItems.map((item) => (
            <div
              key={item.id}
              className={className(
                trashRowClassName,
                selectedItemId === item.id && "selected",
              )}
              role="row"
              tabIndex={0}
              onClick={() => setSelectedItemId(item.id)}
              onContextMenu={(event) => openItemMenu(item, event)}
            >
              <span className={trashCellClassName}>{item.name}</span>
              <span className={trashMetaCellClassName}>
                {item.originalParent}
              </span>
              <span className={trashMetaCellClassName}>
                {formatTrashItemSize(item)}
              </span>
              <span className={trashMetaCellClassName}>
                {formatDate(item.deletedAtMs)}
              </span>
            </div>
          ))}
      </div>
      <footer className={trashFooterClassName}>
        <span>{sortedItems.length} items</span>
      </footer>

      {itemMenu
        ? (
          <FloatingMenu
            className="z-[30] w-[176px]"
            position={{ left: itemMenu.x, top: itemMenu.y }}
          >
            <FloatingMenuItem onClick={() => restoreItem(itemMenu.item)}>
              <RotateCcw size={15} />
              Restore
            </FloatingMenuItem>
            <FloatingMenuItem danger onClick={() => purgeItem(itemMenu.item)}>
              <Trash2 size={15} />
              Delete permanently
            </FloatingMenuItem>
          </FloatingMenu>
        )
        : null}
    </section>
  );
}

function applyTrashItemsEvent(
  current: TrashItem[],
  event: TrashItemsTableEvent,
): TrashItemsState {
  if (event.type === "snapshot") {
    return { phase: "live", items: event.rows, message: "Trash live" };
  }
  if (event.type === "patch") {
    const removes = new Set(event.removes);
    const upserts = new Map(event.upserts.map((item) => [item.id, item]));
    return {
      phase: "live",
      items: [
        ...current.filter((item) =>
          !removes.has(item.id) && !upserts.has(item.id)
        ),
        ...event.upserts,
      ],
      message: "Trash updated",
    };
  }
  return {
    phase: "closed",
    items: current,
    message: `Trash closed: ${event.reason}`,
  };
}

function sortTrashItems(items: TrashItem[]): TrashItem[] {
  return [...items].sort((left, right) =>
    (right.deletedAtMs ?? 0) - (left.deletedAtMs ?? 0) ||
    left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    })
  );
}

function formatTrashItemSize(item: TrashItem): string {
  if (!item.size) return "";
  if (item.size.type === "bytes") return formatSize(item.size.value);
  return `${item.size.value} entries`;
}

function trashItemMenuPosition(x: number, y: number): { x: number; y: number } {
  const position = clampFloatingMenuPosition(x, y, {
    itemCount: 2,
    width: trashContextMenuWidth,
  });
  return { x: position.left, y: position.top };
}

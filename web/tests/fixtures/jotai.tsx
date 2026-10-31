import { atom, useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { JotaiProvider } from "unsaturated/store";

const countAtom = atom(0);
function MountWriter() {
  const setCount = useSetAtom(countAtom);
  useEffect(() => {
    setCount(1);
  }, [setCount]);
  return null;
}
function Reader({
  name,
  initialize = false,
}: {
  name: string;
  initialize?: boolean;
}) {
  const count = useAtomValue(countAtom);
  const setCount = useSetAtom(countAtom);
  return (
    <section>
      {initialize && <MountWriter />}
      <output aria-label={name}>{count}</output>
      <button onClick={() => setCount((value) => value + 1)}>
        Increment {name}
      </button>
    </section>
  );
}
createRoot(document.getElementById("root")!).render(
  <>
    <JotaiProvider>
      <Reader name="first" initialize />
    </JotaiProvider>
    <JotaiProvider>
      <Reader name="second" />
    </JotaiProvider>
  </>,
);

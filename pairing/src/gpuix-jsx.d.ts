import type { HostProps, ImgProps, SvgProps } from "@gpuix/native/host";
import type { HostElement } from "./gpuix.tsx";
export namespace JSX {
  type Element = import("solid-js").Element;
  interface ElementChildrenAttribute {
    children: unknown;
  }
  type Props<T> = T & {
    children?: unknown;
    ref?: HostElement | ((element: HostElement) => void);
  };
  interface IntrinsicElements {
    div: Props<HostProps>;
    text: Props<HostProps>;
    img: Props<ImgProps>;
    svg: Props<SvgProps>;
  }
}

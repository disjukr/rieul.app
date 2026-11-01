/** Keeps a same-origin popup's styles and theme aligned with its opener. */
export function copyDocumentStyles(
  source: Document,
  target: Document,
): () => void {
  const copies: Element[] = [];
  const base = target.createElement("base");
  base.href = source.baseURI;
  target.head.prepend(base);
  const themeAttributes = ["class", "style", "data-theme", "dir", "lang"];

  function syncStyles() {
    for (const copy of copies) copy.remove();
    copies.length = 0;
    for (const element of source.head.querySelectorAll(
      'style, link[rel~="stylesheet"]',
    )) {
      const copy = target.importNode(element, true);
      if (copy.tagName === "LINK")
        (copy as HTMLLinkElement).href = (element as HTMLLinkElement).href;
      target.head.append(copy);
      copies.push(copy);
    }
  }

  function syncTheme() {
    for (const name of themeAttributes) {
      const value = source.documentElement.getAttribute(name);
      if (value === null) target.documentElement.removeAttribute(name);
      else target.documentElement.setAttribute(name, value);
    }
  }

  syncStyles();
  syncTheme();
  const styles = new MutationObserver(syncStyles);
  styles.observe(source.head, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  const theme = new MutationObserver(syncTheme);
  theme.observe(source.documentElement, {
    attributes: true,
    attributeFilter: themeAttributes,
  });
  return () => {
    styles.disconnect();
    theme.disconnect();
    for (const copy of copies) copy.remove();
    base.remove();
  };
}

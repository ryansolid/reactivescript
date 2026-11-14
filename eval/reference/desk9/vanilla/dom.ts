// Small DOM helpers: building elements, and reading errors.

export type Child = Node | string | number | null | undefined | false;
type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], "dataset" | "style">> & {
  testid?: string;
};

/** `h("button", { testid: "save", onclick }, "Save")`: an element with its properties and children */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> | null = null, ...children: Child[]) {
  const node = document.createElement(tag);
  if (props) {
    const { testid, ...rest } = props;
    if (testid) node.dataset.testid = testid;
    Object.assign(node, rest);
  }
  node.append(...nodes(children));
  return node;
}

export const nodes = (children: Child[]): (Node | string)[] =>
  children.filter((c): c is Node | string | number => c !== null && c !== undefined && c !== false).map(c => (typeof c === "number" ? String(c) : c));

/** a button that does not submit, with a test id */
export const button = (testid: string, label: string, onclick: () => void) =>
  h("button", { type: "button", testid, onclick: () => onclick() }, label);

/** a text input with a test id, calling `oninput` with its value */
export function textInput(testid: string, value: string, oninput: (value: string) => void) {
  const input = h("input", { type: "text", testid, value });
  input.addEventListener("input", () => oninput(input.value));
  return input;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** a signal that aborts when `parent` does or when the returned controller is aborted */
export function child(parent: AbortSignal) {
  const controller = new AbortController();
  return { controller, signal: AbortSignal.any([parent, controller.signal]) };
}

/**
 * Hands out signals for one kind of request where only the newest matters (a list per filter, an item per
 * selection): each call aborts the previous one's signal. All of them abort with `parent`.
 */
export function latest(parent: AbortSignal) {
  let current: AbortController | null = null;
  return () => {
    current?.abort();
    const next = child(parent);
    current = next.controller;
    return next.signal;
  };
}

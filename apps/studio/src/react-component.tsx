import { signal, untracked, type Signal } from "@preact/signals-react";
import { useSignals } from "@preact/signals-react/runtime";
import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ElementType,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { withLifecycle, type Lifecycle, type Ref } from "./reactivity";
const Context = createContext(new Map<symbol, unknown>());
type EventMap = Record<string, unknown[]>;
type Camel<S extends string> = S extends `${infer A}:${infer B}`
  ? `${A}${Capitalize<Camel<B>>}`
  : S;
type EventProps<E> = {
  [
    K in keyof E as K extends string ? `on${Capitalize<Camel<K>>}` : never
  ]?: E[K] extends unknown[] ? (...args: E[K]) => void : never;
};
export type StudioComponent<P, E> = React.ForwardRefExoticComponent<
  P & EventProps<E> & { className?: string } & React.RefAttributes<unknown>
>;
export function component<
  P extends object,
  E extends { [K in keyof E]: unknown[] } = EventMap,
>(
  name: string,
  setup: (
    props: P,
    emit: <K extends keyof E>(event: K, ...args: E[K]) => void,
    expose: (api: object) => void,
  ) => () => ReactNode,
  defaults: Partial<P> = {},
): StudioComponent<P, E> {
  const Component = React.forwardRef<
    unknown,
    P & EventProps<E> & { className?: string }
  >((incoming, forwarded) => {
    const inherited = useContext(Context);
    type Model = {
      props: Signal<P>;
      scope: Lifecycle;
      render: () => ReactNode;
      exposed: object;
      active: boolean;
      mounted: boolean;
    };
    const latest = useRef(incoming);
    latest.current = incoming;
    const [current, setCurrent] = useState<Model | null>(null);
    // Controllers own subscriptions, async guards and DOM cleanup. Create them
    // only after React commits, so abandoned renders cannot leak effects.
    useLayoutEffect(() => {
      const scope: Lifecycle = {
        context: new Map(inherited),
        mounted: [],
        cleanup: [],
      };
      const values = signal({ ...defaults, ...latest.current } as P);
      const holder: Model = {
        props: values,
        scope,
        render: () => null,
        exposed: {},
        active: true,
        mounted: false,
      };
      const props = new Proxy({} as P, {
        get: (_, key) => values.value[key as keyof P],
        has: (_, key) => key in values.value,
        ownKeys: () => Reflect.ownKeys(values.value),
        getOwnPropertyDescriptor: () => ({
          enumerable: true,
          configurable: true,
        }),
      });
      const dispose = () => {
        if (!holder.active) return;
        // Cleanup may notify a still-mounted parent before closing this model.
        for (const callback of [...scope.cleanup].reverse()) void callback();
        holder.active = false;
      };
      try {
        holder.render = withLifecycle(scope, () =>
          setup(
            props,
            (event, ...args) => {
              if (!holder.active) return;
              const key =
                "on" +
                String(event).replace(/(^.|[:-].)/g, (text) =>
                  text.replace(/[:-]/, "").toUpperCase(),
                );
              const handler = (values.peek() as Record<string, unknown>)[key];
              if (typeof handler === "function") handler(...args);
            },
            (api) => {
              holder.exposed = api;
            },
          ),
        );
      } catch (error) {
        dispose();
        throw error;
      }
      setCurrent(holder);
      // StrictMode and Fast Refresh reactivate this effect with a fresh model,
      // including fresh alive/disposed flags and watcher subscriptions.
      return dispose;
    }, [inherited]);
    useLayoutEffect(() => {
      if (!current?.active) return;
      untracked(() => {
        const next = { ...defaults, ...incoming } as P;
        const previous = current.props.peek();
        if (
          Object.keys(next).length !== Object.keys(previous).length ||
          Object.keys(next).some(
            (key) => next[key as keyof P] !== previous[key as keyof P],
          )
        )
          current.props.value = next;
      });
    });
    useImperativeHandle(
      forwarded,
      () => (current?.active ? current.exposed : null),
      [current],
    );
    useEffect(() => {
      if (!current?.active || current.mounted) return;
      current.mounted = true;
      for (const callback of current.scope.mounted) void callback();
    }, [current]);
    const tracking = useSignals(1, name);
    try {
      if (!current?.active) return null;
      let rendered = current.render();
      if (
        (incoming as { className?: string }).className &&
        React.isValidElement<{ className?: string }>(rendered)
      )
        rendered = React.cloneElement(rendered, {
          className: [
            rendered.props.className,
            (incoming as { className?: string }).className,
          ]
            .filter(Boolean)
            .join(" "),
        });
      return React.createElement(
        Context.Provider,
        { value: current.scope.context },
        rendered,
      );
    } finally {
      tracking.f();
    }
  });
  Component.displayName = name;
  return Component as StudioComponent<P, E>;
}
export function classes(...items: unknown[]): string {
  return items
    .flatMap((item) =>
      typeof item === "string"
        ? [item]
        : Array.isArray(item)
          ? [classes(...item)]
          : item && typeof item === "object"
            ? Object.entries(item)
                .filter(([, value]) => !!value)
                .map(([key]) => key)
            : [],
    )
    .filter(Boolean)
    .join(" ");
}
export function element(
  tag: ElementType,
  props: Record<string, unknown> | null,
  ...children: unknown[]
): ReactNode {
  // onInput also supports editor integrations dispatching native input events.
  if (
    typeof tag === "string" &&
    ["input", "textarea"].includes(tag) &&
    props?.onInput &&
    !props.onChange
  )
    props = { ...props, onChange: props.onInput };
  return React.createElement(tag, props, ...(children as ReactNode[]));
}
export const Fragment = React.Fragment;
export function portal(children: ReactNode) {
  return createPortal(children, document.body);
}
const refCallbacks = new WeakMap<object, (node: never) => void>();
export function domRef<T>(cell: Ref<T>): (node: T) => void {
  const existing = refCallbacks.get(cell);
  if (existing) return existing as (node: T) => void;
  const callback = (node: T) => {
    if (cell.value !== node) cell.value = node;
  };
  refCallbacks.set(cell, callback as (node: never) => void);
  return callback;
}
export function renderList<T>(values: T[] | undefined | null): T[];
export function renderList(values: number): number[];
export function renderList<T>(values: Record<string, T>): [T, string][];
export function renderList(values: unknown): unknown[] {
  return Array.isArray(values)
    ? values
    : typeof values === "number"
      ? Array.from({ length: values }, (_, i) => i + 1)
      : values && typeof values === "object"
        ? Object.entries(values).map(([key, value]) => [value, key])
        : [];
}
export type EventHandler<
  C extends ElementType,
  K extends PropertyKey,
> = K extends keyof React.ComponentProps<C>
  ? NonNullable<React.ComponentProps<C>[K]>
  : never;
export function domEvent(handler: (event: Event) => unknown) {
  return (event: React.SyntheticEvent) => handler(event as unknown as Event);
}
export function combineEvents(
  ...handlers: ((event: React.SyntheticEvent) => unknown)[]
) {
  return (event: React.SyntheticEvent) => {
    for (const handler of handlers) handler(event);
  };
}
export function modelValue<T extends string | number>(
  element: HTMLSelectElement,
  current: T,
): T {
  return (
    typeof current === "number" ? Number(element.value) : element.value
  ) as T;
}
export interface EditorHandle {
  flush(): void;
  forget(path?: string): void;
  isBusy(): boolean;
  draft(): {
    initial: Record<string, import("../shared/types").Json>;
    initialBody: string;
  };
  open(
    path: string,
    initial?: Record<string, import("../shared/types").Json>,
    initialBody?: string,
  ): void;
}

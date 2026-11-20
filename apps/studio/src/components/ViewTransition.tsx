import { useAnimate } from "motion/react-mini";
import { useLayoutEffect, useRef, type ReactNode } from "react";

const depth = { section: 0, detail: 1, edit: 2 };

type Props = {
  viewId: string;
  mode: keyof typeof depth;
  children: ReactNode;
};

export default function ViewTransition({ viewId, mode, children }: Props) {
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const previous = useRef({ viewId, mode });

  useLayoutEffect(() => {
    const from = previous.current;
    previous.current = { viewId, mode };
    if (from.viewId === viewId && from.mode === mode) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const offset = Math.sign(depth[mode] - depth[from.mode]) * 6;
    const animation = animate(scope.current, {
      opacity: [0.72, 1],
      ...(offset && { transform: [`translateX(${offset}px)`, "none"] }),
    }, { duration: 0.15, ease: "easeOut" });
    return () => animation.cancel();
  }, [viewId, mode, scope, animate]);

  return <div className="studio-view" ref={scope}>{children}</div>;
}

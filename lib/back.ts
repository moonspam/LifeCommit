import { useEffect, useRef } from "react";

type BackHandler = () => void;

const backStack: BackHandler[] = [];

/**
 * Pushes a close/back handler onto the back stack.
 * Returns an idempotent unregister function to remove it when unmounted/closed.
 */
export function pushBack(fn: BackHandler): () => void {
  backStack.push(fn);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const idx = backStack.lastIndexOf(fn);
    if (idx !== -1) {
      backStack.splice(idx, 1);
    }
  };
}

/**
 * Pops and executes the topmost back handler.
 * Returns true if a handler was executed, false if the stack was empty.
 */
export function popBack(): boolean {
  const handler = backStack.pop();
  if (handler) {
    handler();
    return true;
  }
  return false;
}

/**
 * React hook that registers onClose with the back stack while active is true.
 * Preserves registration order across re-renders by storing onClose in a ref.
 */
export function useBackClose(active: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    return pushBack(() => {
      onCloseRef.current();
    });
  }, [active]);
}

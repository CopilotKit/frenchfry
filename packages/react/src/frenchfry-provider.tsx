import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useMemo,
  useRef
} from "react";

/**
 * Represents a structured runtime warning surfaced by Frenchfry React bindings.
 */
export type FrenchfryWarning = {
  code: "gen_ui_parse_failed" | "outlet_not_found";
  message: string;
  outlet?: string;
};

type OutletListener = (elements: ReactElement[] | null) => void;

type FrenchfryUiBus = {
  publishOutlet: (outlet: string, elements: ReactElement[]) => void;
  registerOutlet: (outlet: string, listener: OutletListener) => () => void;
  warn: (warning: FrenchfryWarning) => void;
};

/**
 * Represents provider props for global Frenchfry UI wiring.
 */
export type FrenchfryProviderProps = {
  children: ReactNode;
  onWarning?: (warning: FrenchfryWarning) => void;
};

/**
 * React context carrying the outlet registration and publishing bus.
 */
export const FrenchfryUiContext = createContext<FrenchfryUiBus | null>(null);

/**
 * Provides a global outlet bus that connects `VoiceAgent`/`useGenUi` to `VoiceUiOutlet` instances.
 *
 * @param props Provider props.
 * @returns Provider element.
 */
export const FrenchfryProvider = (
  props: FrenchfryProviderProps
): ReactElement => {
  const listenersByOutletRef = useRef<Map<string, Set<OutletListener>>>(
    new Map()
  );
  const latestByOutletRef = useRef<Map<string, ReactElement[]>>(new Map());

  /**
   * Emits a warning to the optional host callback.
   *
   * @param warning Warning payload.
   */
  const warn = useCallback(
    (warning: FrenchfryWarning): void => {
      props.onWarning?.(warning);
    },
    [props.onWarning]
  );

  /**
   * Publishes rendered React elements to an outlet and all active listeners.
   *
   * @param outlet Outlet name.
   * @param elements Rendered elements.
   */
  const publishOutlet = useCallback(
    (outlet: string, elements: ReactElement[]): void => {
      latestByOutletRef.current.set(outlet, elements);
      const listeners = listenersByOutletRef.current.get(outlet);

      if (listeners === undefined || listeners.size === 0) {
        warn({
          code: "outlet_not_found",
          message: `No mounted VoiceUiOutlet found for outlet "${outlet}".`,
          outlet
        });
        return;
      }

      listeners.forEach((listener) => {
        listener(elements);
      });
    },
    [warn]
  );

  /**
   * Registers an outlet listener and replays the latest payload if present.
   *
   * @param outlet Outlet name.
   * @param listener Listener callback.
   * @returns Cleanup function that unregisters the listener.
   */
  const registerOutlet = useCallback(
    (outlet: string, listener: OutletListener): (() => void) => {
      const listeners = listenersByOutletRef.current.get(outlet) ?? new Set();
      listeners.add(listener);
      listenersByOutletRef.current.set(outlet, listeners);

      const latest = latestByOutletRef.current.get(outlet);
      if (latest !== undefined) {
        listener(latest);
      }

      return (): void => {
        const latestListeners = listenersByOutletRef.current.get(outlet);
        if (latestListeners === undefined) {
          return;
        }

        latestListeners.delete(listener);
        if (latestListeners.size === 0) {
          listenersByOutletRef.current.delete(outlet);
        }
      };
    },
    []
  );

  const value = useMemo<FrenchfryUiBus>(() => {
    return {
      publishOutlet,
      registerOutlet,
      warn
    };
  }, [publishOutlet, registerOutlet, warn]);

  return (
    <FrenchfryUiContext.Provider value={value}>
      {props.children}
    </FrenchfryUiContext.Provider>
  );
};

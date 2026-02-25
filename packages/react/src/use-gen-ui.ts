import { type UiWrapper } from "@hashbrownai/core";
import { type OrchestrationTool } from "@frenchfryai/core";
import {
  type ExposedComponent,
  useJsonParser,
  type UiKit
} from "@hashbrownai/react";
import {
  type ComponentType,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

import { FrenchfryUiContext } from "./frenchfry-provider";

/**
 * Represents an imperative UI generation registration consumed by `VoiceAgent`.
 */
export type GenUiRegistration = {
  id: string;
  onToolCallDelta: (input: { callId: string; delta: string }) => void;
  onToolCallDone: (input: { callId: string; name?: string }) => void;
  onToolCallStart: (input: { callId: string }) => void;
  orchestrationTool: OrchestrationTool;
  sessionTool: {
    description: string;
    name: string;
    parameters: unknown;
    type: "function";
  };
};

/**
 * Represents configuration for `useGenUi`.
 */
export type UseGenUiOptions = {
  kit: UiKit<ExposedComponent<ComponentType<unknown>>>;
  outlet: string;
  toolName?: string;
  toolNames?: readonly string[];
};

/**
 * Creates an outlet-targeted UI generation pipeline backed by Hashbrown parsing/rendering.
 *
 * @param options UI generation options.
 * @returns Registration object consumed by `VoiceAgent`.
 */
export const useGenUi = (options: UseGenUiOptions): GenUiRegistration => {
  const toolName = options.toolName ?? "render_ui";
  const uiBus = useContext(FrenchfryUiContext);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [streamingJsonByCallId, setStreamingJsonByCallId] = useState<
    Readonly<Record<string, string>>
  >({});
  const registrationIdRef = useRef<string>(
    `gen-ui-${Math.random().toString(36).slice(2)}`
  );
  const streamingJson = useMemo(() => {
    if (activeCallId === null) {
      return "";
    }

    return streamingJsonByCallId[activeCallId] ?? "";
  }, [activeCallId, streamingJsonByCallId]);

  const parsed = useJsonParser(streamingJson, options.kit.schema);

  useEffect(() => {
    if (uiBus === null || activeCallId === null) {
      return;
    }

    if (parsed.error !== undefined) {
      uiBus.warn({
        code: "gen_ui_parse_failed",
        message: parsed.error.message,
        outlet: options.outlet
      });
      return;
    }

    if (parsed.value === undefined) {
      return;
    }

    if (!isUiWrapper(parsed.value)) {
      return;
    }

    uiBus.publishOutlet(options.outlet, options.kit.render(parsed.value));
  }, [
    activeCallId,
    options.kit,
    options.outlet,
    parsed.error,
    parsed.value,
    uiBus
  ]);

  /**
   * Handles a newly observed tool call stream.
   *
   * @param input Start payload.
   */
  const onToolCallStart = useCallback((input: { callId: string }): void => {
    setActiveCallId(input.callId);
    setStreamingJsonByCallId((previous) => {
      return {
        ...previous,
        [input.callId]: ""
      };
    });
  }, []);

  /**
   * Handles argument deltas for the active tool call stream.
   *
   * @param input Delta payload.
   */
  const onToolCallDelta = useCallback(
    (input: { callId: string; delta: string }): void => {
      setStreamingJsonByCallId((previous) => {
        return {
          ...previous,
          [input.callId]: `${previous[input.callId] ?? ""}${input.delta}`
        };
      });
    },
    []
  );

  /**
   * Handles end-of-stream bookkeeping and optional tool-name filtering.
   *
   * @param input Done payload.
   */
  const onToolCallDone = useCallback(
    (input: { callId: string; name?: string }): void => {
      if (activeCallId !== input.callId) {
        return;
      }

      const shouldPublish = shouldHandleToolName(input.name, options.toolNames);
      if (!shouldPublish) {
        setActiveCallId(null);
        setStreamingJsonByCallId((previous) => {
          if (!(input.callId in previous)) {
            return previous;
          }

          const next = { ...previous };
          delete next[input.callId];
          return next;
        });
      }
    },
    [activeCallId, options.toolNames]
  );

  return useMemo<GenUiRegistration>(() => {
    const sessionTool = {
      description:
        "Render Hashbrown UiWrapper payload into the configured outlet.",
      name: toolName,
      parameters: {
        additionalProperties: true,
        properties: {
          ui: {
            items: {
              additionalProperties: true,
              type: "object"
            },
            type: "array"
          }
        },
        required: ["ui"],
        type: "object"
      },
      type: "function" as const
    };

    return {
      id: registrationIdRef.current,
      onToolCallDelta,
      onToolCallDone,
      onToolCallStart,
      orchestrationTool: {
        description: sessionTool.description,
        handler: (input: unknown): Promise<unknown> => {
          const accepted = isUiWrapper(input);
          return Promise.resolve({
            accepted,
            ...(accepted
              ? { componentCount: input.ui.length }
              : { reason: "Expected UiWrapper payload with ui array." })
          });
        },
        name: toolName
      },
      sessionTool
    };
  }, [onToolCallDelta, onToolCallDone, onToolCallStart, toolName]);
};

/**
 * Determines whether a done event should be rendered for a configured tool-name filter.
 *
 * @param name Tool name from done event.
 * @param allowedToolNames Optional allowed list.
 * @returns True when the event should be rendered.
 */
export const shouldHandleToolName = (
  name: string | undefined,
  allowedToolNames: readonly string[] | undefined
): boolean => {
  if (allowedToolNames === undefined) {
    return true;
  }

  if (name === undefined) {
    return false;
  }

  return allowedToolNames.includes(name);
};

/**
 * Type guard for runtime values that match Hashbrown's UI wrapper shape.
 *
 * @param value Runtime value.
 * @returns True when value is a UI wrapper.
 */
export const isUiWrapper = (value: unknown): value is UiWrapper => {
  if (!hasUiProperty(value)) {
    return false;
  }

  return Array.isArray(value.ui);
};

/**
 * Determines whether a value is an object containing a top-level `ui` key.
 *
 * @param value Runtime value.
 * @returns True when a `ui` property exists.
 */
const hasUiProperty = (value: unknown): value is { ui: unknown } => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return Object.prototype.hasOwnProperty.call(value, "ui");
};

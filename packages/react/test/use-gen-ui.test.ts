// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactElement, type ReactNode } from "react";
import { expect, test, vi } from "vitest";

import {
  FrenchfryUiContext,
  type FrenchfryWarning
} from "../src/frenchfry-provider";
import {
  isUiWrapper,
  shouldHandleToolName,
  useGenUi,
  type UseGenUiOptions
} from "../src/use-gen-ui";

type MockJsonParserResult = {
  error: Error | undefined;
  parserState: Record<string, unknown>;
  value: unknown;
};

const useJsonParserMock =
  vi.fn<(json: string, schema: unknown) => MockJsonParserResult>();

vi.mock("@hashbrownai/react", async () => {
  const actual = await vi.importActual("@hashbrownai/react");
  return {
    ...actual,
    useJsonParser: (json: string, schema: unknown): MockJsonParserResult => {
      return useJsonParserMock(json, schema);
    }
  };
});

type WrapperProps = {
  children: ReactNode;
  publishOutlet: (outlet: string, elements: ReactElement[]) => void;
  warn: (warning: FrenchfryWarning) => void;
};

/**
 * Wraps hook tests in a Frenchfry UI bus provider.
 *
 * @param props Wrapper props.
 * @returns Provider element.
 */
const Wrapper = (props: WrapperProps): ReactElement => {
  return createElement(
    FrenchfryUiContext.Provider,
    {
      value: {
        publishOutlet: props.publishOutlet,
        registerOutlet: () => {
          return () => {
            return;
          };
        },
        warn: props.warn
      }
    },
    props.children
  );
};

/**
 * Creates a minimal `UseGenUiOptions` object for tests.
 *
 * @returns Hook options.
 */
const createOptions = (): UseGenUiOptions => {
  return {
    kit: {
      render: () => {
        return [];
      },
      schema: {
        fromJsonAst: () => {
          return {
            cache: {
              byNodeId: {},
              byNodeIdAndSchemaId: {}
            },
            result: {
              state: "no-match"
            }
          };
        },
        toJsonSchema: () => {
          return {};
        },
        toTypeScript: () => {
          return "type Ui = unknown";
        },
        validate: () => {
          return;
        }
      }
    } as unknown as UseGenUiOptions["kit"],
    outlet: "voice-main"
  };
};

test("useGenUi publishes rendered output when parser resolves ui wrapper", () => {
  // Arrange
  useJsonParserMock.mockReturnValue({
    error: undefined,
    parserState: {},
    value: {
      ui: []
    }
  });

  const publishOutlet = vi.fn();
  const warn = vi.fn();

  const result = renderHook(
    () => {
      return useGenUi(createOptions());
    },
    {
      wrapper: ({ children }) => {
        return createElement(Wrapper, { children, publishOutlet, warn });
      }
    }
  );

  // Act
  act(() => {
    result.result.current.onToolCallStart({
      callId: "call_1"
    });
  });

  // Assert
  expect(publishOutlet).toHaveBeenCalledWith("voice-main", []);
  expect(warn).not.toHaveBeenCalled();
});

test("useGenUi warns when parser returns an error", () => {
  // Arrange
  useJsonParserMock.mockReturnValue({
    error: new Error("Invalid JSON"),
    parserState: {},
    value: undefined
  });

  const publishOutlet = vi.fn();
  const warn = vi.fn();

  const result = renderHook(
    () => {
      return useGenUi(createOptions());
    },
    {
      wrapper: ({ children }) => {
        return createElement(Wrapper, { children, publishOutlet, warn });
      }
    }
  );

  // Act
  act(() => {
    result.result.current.onToolCallStart({
      callId: "call_error"
    });
  });

  // Assert
  expect(warn).toHaveBeenCalled();
});

test("useGenUi appends deltas and clears state when done filter rejects tool", () => {
  // Arrange
  useJsonParserMock.mockReturnValue({
    error: undefined,
    parserState: {},
    value: undefined
  });

  const publishOutlet = vi.fn();
  const warn = vi.fn();
  const options = createOptions();
  options.toolNames = ["render_ui"];

  const result = renderHook(
    () => {
      return useGenUi(options);
    },
    {
      wrapper: ({ children }) => {
        return createElement(Wrapper, { children, publishOutlet, warn });
      }
    }
  );

  // Act
  act(() => {
    result.result.current.onToolCallStart({
      callId: "call_filter"
    });
    result.result.current.onToolCallDelta({
      callId: "call_filter",
      delta: '{"ui":[]}'
    });
    result.result.current.onToolCallDone({
      callId: "call_filter",
      name: "different_tool"
    });
  });

  // Assert
  expect(useJsonParserMock).toHaveBeenCalled();
  expect(publishOutlet).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

test("useGenUi handles missing provider context without throwing", () => {
  // Arrange
  useJsonParserMock.mockReturnValue({
    error: undefined,
    parserState: {},
    value: {
      ui: []
    }
  });

  // Act
  const result = renderHook(() => {
    return useGenUi(createOptions());
  });

  // Assert
  expect(typeof result.result.current.onToolCallStart).toBe("function");
});

test("useGenUi keeps per-call json buffers isolated for interleaved deltas", () => {
  // Arrange
  useJsonParserMock.mockReturnValue({
    error: undefined,
    parserState: {},
    value: undefined
  });
  const publishOutlet = vi.fn();
  const warn = vi.fn();

  const result = renderHook(
    () => {
      return useGenUi(createOptions());
    },
    {
      wrapper: ({ children }) => {
        return createElement(Wrapper, { children, publishOutlet, warn });
      }
    }
  );

  // Act
  act(() => {
    result.result.current.onToolCallStart({
      callId: "call_1"
    });
    result.result.current.onToolCallDelta({
      callId: "call_1",
      delta: '{"a":'
    });
    result.result.current.onToolCallStart({
      callId: "call_2"
    });
    result.result.current.onToolCallDelta({
      callId: "call_2",
      delta: '{"b":1}'
    });
    result.result.current.onToolCallDelta({
      callId: "call_1",
      delta: "1}"
    });
  });

  // Assert
  const lastCall = useJsonParserMock.mock.calls.at(-1);
  expect(lastCall?.at(0)).toBe('{"b":1}');
  expect(publishOutlet).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

test("tool-name filter helper handles all branches", () => {
  // Arrange / Act / Assert
  expect(shouldHandleToolName(undefined, undefined)).toBe(true);
  expect(shouldHandleToolName(undefined, ["render_ui"])).toBe(false);
  expect(shouldHandleToolName("other", ["render_ui"])).toBe(false);
  expect(shouldHandleToolName("render_ui", ["render_ui"])).toBe(true);
});

test("ui wrapper guard validates shape", () => {
  // Arrange / Act / Assert
  expect(isUiWrapper(null)).toBe(false);
  expect(isUiWrapper({})).toBe(false);
  expect(isUiWrapper({ ui: "nope" })).toBe(false);
  expect(isUiWrapper({ ui: [] })).toBe(true);
});

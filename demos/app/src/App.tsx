import type { OrchestrationTool } from "@frenchfryai/core";
import {
  FrenchfryProvider,
  VoiceAgent,
  VoiceUiOutlet,
  useGenUi,
  useTool,
  useUiKit,
  useVoiceAgent,
  type FrenchfryWarning
} from "@frenchfryai/react";
import { s } from "@hashbrownai/core";
import { exposeComponent } from "@hashbrownai/react";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import { z } from "zod";

import "./app.css";

type LogEntry = {
  id: string;
  level: "error" | "info";
  message: string;
  timestamp: string;
};

type SessionToolDefinition = {
  description: string;
  name: string;
  parameters: unknown;
  type: "function";
};

const lookupOrderToolParameters: unknown = {
  additionalProperties: false,
  properties: {
    orderId: {
      type: "string"
    }
  },
  required: ["orderId"],
  type: "object"
};

const renderUiToolParameters: unknown = {
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
};

const statusPillPropsSchema = z.object({
  label: z.string(),
  tone: z.enum(["critical", "healthy", "watch"])
});

const statCardPropsSchema = z.object({
  label: z.string(),
  tone: z.enum(["critical", "healthy", "watch"]),
  value: z.string()
});

const taskListPropsSchema = z.object({
  items: z.array(z.string()),
  title: z.string()
});

const demoServerConfigSchema = z.object({
  realtimeWebSocketUrl: z.string().url()
});

const lookupOrderInputSchema = z.object({
  orderId: z.string().min(1)
});

const renderUiInputSchema = z.object({
  ui: z.array(z.record(z.string(), z.unknown()))
});

const defaultServerHttpUrl = "http://localhost:8787";

/**
 * Renders a compact status badge for generated UI.
 *
 * @param props Badge label and tone.
 * @returns Styled badge element.
 */
const StatusPill = (props: unknown): ReactElement => {
  const parsed = statusPillPropsSchema.safeParse(props);
  if (!parsed.success) {
    return (
      <span className="status-pill tone-watch">Invalid StatusPill props</span>
    );
  }

  return (
    <span className={`status-pill tone-${parsed.data.tone}`}>
      {parsed.data.label}
    </span>
  );
};

/**
 * Renders a generated metric card.
 *
 * @param props Card label, value, and visual tone.
 * @returns Metric card element.
 */
const StatCard = (props: unknown): ReactElement => {
  const parsed = statCardPropsSchema.safeParse(props);
  if (!parsed.success) {
    return (
      <article className="stat-card tone-watch">
        <p className="stat-label">Invalid StatCard props</p>
      </article>
    );
  }

  return (
    <article className={`stat-card tone-${parsed.data.tone}`}>
      <p className="stat-label">{parsed.data.label}</p>
      <p className="stat-value">{parsed.data.value}</p>
    </article>
  );
};

/**
 * Renders a generated checklist of next actions.
 *
 * @param props List title and task items.
 * @returns Task list element.
 */
const TaskList = (props: unknown): ReactElement => {
  const parsed = taskListPropsSchema.safeParse(props);
  if (!parsed.success) {
    return (
      <section className="task-list">
        <h3>Invalid TaskList props</h3>
      </section>
    );
  }

  return (
    <section className="task-list">
      <h3>{parsed.data.title}</h3>
      <ul>
        {parsed.data.items.map((item) => {
          return <li key={item}>{item}</li>;
        })}
      </ul>
    </section>
  );
};

/**
 * Fetches and validates runtime websocket configuration from the demo server.
 *
 * @param serverHttpUrl HTTP URL of the demo server.
 * @returns Loading, error, and resolved websocket URL state.
 */
const useDemoServerConfig = (
  serverHttpUrl: string
): {
  error?: string;
  isLoading: boolean;
  realtimeWebSocketUrl?: string;
} => {
  const [state, setState] = useState<{
    error?: string;
    isLoading: boolean;
    realtimeWebSocketUrl?: string;
  }>({
    isLoading: true
  });

  useEffect(() => {
    const abortController = new AbortController();
    setState({
      isLoading: true
    });

    void fetch(`${serverHttpUrl}/config`, {
      signal: abortController.signal
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `Server config request failed with ${response.status}.`
          );
        }

        const json: unknown = await response.json();
        const parsed = demoServerConfigSchema.safeParse(json);
        if (!parsed.success) {
          throw new Error("Server config payload is invalid.");
        }

        return parsed.data;
      })
      .then((config) => {
        setState({
          isLoading: false,
          realtimeWebSocketUrl: config.realtimeWebSocketUrl
        });
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted) {
          return;
        }

        const message =
          error instanceof Error ? error.message : "Unknown config error.";
        setState({
          error: message,
          isLoading: false
        });
      });

    return (): void => {
      abortController.abort();
    };
  }, [serverHttpUrl]);

  return state;
};

/**
 * Creates a session update event from runtime tool definitions.
 *
 * @param tools Session tool definitions exposed to the model.
 * @returns Session update event payload.
 */
const createSessionUpdateEvent = (
  tools: readonly SessionToolDefinition[]
): {
  session: {
    modalities: ["text", "audio"];
    tool_choice: "auto";
    tools: readonly SessionToolDefinition[];
    turn_detection: null;
  };
  type: "session.update";
} => {
  return {
    session: {
      modalities: ["text", "audio"],
      tool_choice: "auto",
      tools,
      turn_detection: null
    },
    type: "session.update"
  };
};

/**
 * Creates an async delay that is abortable via `AbortSignal`.
 *
 * @param ms Delay in milliseconds.
 * @param signal Abort signal.
 * @returns Promise resolved when delay completes.
 */
const waitFor = (ms: number, signal: AbortSignal): Promise<void> => {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      resolve();
    }, ms);

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeoutId);
        reject(new Error("Operation aborted."));
      },
      {
        once: true
      }
    );
  });
};

/**
 * Creates `VoiceAgent` runtime tool registrations from hashbrown tools.
 *
 * @param input Tool metadata and runtime handlers.
 * @returns Runtime tool list for `VoiceAgent`.
 */
const useVoiceAgentTools = (input: {
  lookupOrderEtaTool: {
    description: string;
    handler: (
      input: { orderId: string },
      abortSignal: AbortSignal
    ) => Promise<unknown>;
    name: string;
  };
  renderUiTool: {
    description: string;
    handler: (
      input: { ui: Record<string, unknown>[] },
      abortSignal: AbortSignal
    ) => Promise<unknown>;
    name: string;
  };
}): {
  sessionTools: readonly SessionToolDefinition[];
  voiceAgentTools: readonly OrchestrationTool[];
} => {
  const sessionTools = useMemo<readonly SessionToolDefinition[]>(() => {
    return [
      {
        description: input.lookupOrderEtaTool.description,
        name: input.lookupOrderEtaTool.name,
        parameters: lookupOrderToolParameters,
        type: "function"
      },
      {
        description: input.renderUiTool.description,
        name: input.renderUiTool.name,
        parameters: renderUiToolParameters,
        type: "function"
      }
    ];
  }, [input.lookupOrderEtaTool, input.renderUiTool]);

  const voiceAgentTools = useMemo<readonly OrchestrationTool[]>(() => {
    return [
      {
        description: input.lookupOrderEtaTool.description,
        handler: async (
          toolInput: unknown,
          abortSignal: AbortSignal
        ): Promise<unknown> => {
          const parsed = lookupOrderInputSchema.safeParse(toolInput);
          if (!parsed.success) {
            return {
              error: "Expected input object: { orderId: string }"
            };
          }

          return input.lookupOrderEtaTool.handler(parsed.data, abortSignal);
        },
        name: input.lookupOrderEtaTool.name
      },
      {
        description: input.renderUiTool.description,
        handler: async (
          toolInput: unknown,
          abortSignal: AbortSignal
        ): Promise<unknown> => {
          const parsed = renderUiInputSchema.safeParse(toolInput);
          if (!parsed.success) {
            return {
              accepted: false,
              reason: "Expected a Hashbrown UiWrapper payload."
            };
          }

          return input.renderUiTool.handler(parsed.data, abortSignal);
        },
        name: input.renderUiTool.name
      }
    ];
  }, [input.lookupOrderEtaTool, input.renderUiTool]);

  return {
    sessionTools,
    voiceAgentTools
  };
};

/**
 * Renders the interactive voice-first agent console.
 *
 * @param props Session tool definitions.
 * @returns Console UI element.
 */
const AgentConsole = (props: {
  sessionTools: readonly SessionToolDefinition[];
}): ReactElement => {
  const voiceAgent = useVoiceAgent();
  const [sessionConfigured, setSessionConfigured] = useState(false);

  if (voiceAgent === null) {
    return (
      <section className="panel">
        <h2>Agent Console</h2>
        <p>Voice agent context is not available.</p>
      </section>
    );
  }

  useEffect(() => {
    if (voiceAgent.status !== "running") {
      setSessionConfigured(false);
      return;
    }

    if (sessionConfigured) {
      return;
    }

    voiceAgent.sendEvent(createSessionUpdateEvent(props.sessionTools));
    setSessionConfigured(true);
  }, [props.sessionTools, sessionConfigured, voiceAgent]);

  return (
    <section className="panel">
      <h2>Voice Console</h2>
      <p className="status-line">
        Agent: <strong>{voiceAgent.status}</strong>
      </p>
      <p className="status-line">
        Input: <strong>{voiceAgent.voiceInputStatus}</strong>
      </p>
      <div className="button-row">
        <button
          className="primary"
          disabled={
            voiceAgent.status === "connecting" ||
            voiceAgent.status === "running"
          }
          onClick={voiceAgent.start}
          type="button"
        >
          Connect
        </button>
        <button
          className="secondary"
          disabled={voiceAgent.status === "idle"}
          onClick={voiceAgent.stop}
          type="button"
        >
          Disconnect
        </button>
      </div>
      <div className="button-row">
        <button
          className="primary"
          disabled={
            !voiceAgent.isRunning || voiceAgent.voiceInputStatus === "recording"
          }
          onClick={() => {
            void voiceAgent.startVoiceInput();
          }}
          type="button"
        >
          Start Talking
        </button>
        <button
          className="secondary"
          disabled={voiceAgent.voiceInputStatus !== "recording"}
          onClick={() => {
            voiceAgent.stopVoiceInput({
              commit: true
            });
          }}
          type="button"
        >
          Stop + Send
        </button>
        <button
          className="secondary"
          disabled={voiceAgent.voiceInputStatus !== "recording"}
          onClick={() => {
            voiceAgent.stopVoiceInput({
              commit: false
            });
          }}
          type="button"
        >
          Cancel Capture
        </button>
      </div>
      <h3>Active Tool Calls</h3>
      {voiceAgent.activeToolCalls.length === 0 ? (
        <p className="muted">No active tool calls.</p>
      ) : (
        <ul className="tool-call-list">
          {voiceAgent.activeToolCalls.map((toolCall) => {
            return (
              <li key={toolCall.callId}>
                <code>{toolCall.name ?? "unknown_tool"}</code> (
                {toolCall.status})
              </li>
            );
          })}
        </ul>
      )}
      {voiceAgent.lastError === undefined ? null : (
        <p className="error-line">
          {voiceAgent.lastError.type}: {voiceAgent.lastError.message}
        </p>
      )}
    </section>
  );
};

/**
 * Renders the complete demo application shell.
 *
 * @returns Demo app element.
 */
export const App = (): ReactElement => {
  const [logs, setLogs] = useState<readonly LogEntry[]>([]);
  const serverHttpUrl = defaultServerHttpUrl;
  const config = useDemoServerConfig(serverHttpUrl);

  /**
   * Appends a new log entry in reverse chronological order.
   *
   * @param level Log severity.
   * @param message Log message.
   */
  const appendLog = useCallback(
    (level: "error" | "info", message: string): void => {
      setLogs((previous) => {
        const next: LogEntry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          level,
          message,
          timestamp: new Date().toISOString()
        };
        return [next, ...previous].slice(0, 10);
      });
    },
    []
  );

  /**
   * Handles warnings emitted by Frenchfry provider internals.
   *
   * @param warning Structured warning payload.
   */
  const handleWarning = useCallback(
    (warning: FrenchfryWarning): void => {
      appendLog("error", `${warning.code}: ${warning.message}`);
    },
    [appendLog]
  );

  const statusPill = useMemo(() => {
    return exposeComponent(StatusPill, {
      description: "Displays a concise service health badge.",
      name: "StatusPill",
      props: {
        label: s.string("Short status label."),
        tone: s.enumeration("Visual severity tone.", [
          "critical",
          "healthy",
          "watch"
        ])
      }
    });
  }, []);

  const statCard = useMemo(() => {
    return exposeComponent(StatCard, {
      description: "Displays a metric label and value card.",
      name: "StatCard",
      props: {
        label: s.string("Metric label."),
        tone: s.enumeration("Visual severity tone.", [
          "critical",
          "healthy",
          "watch"
        ]),
        value: s.string("Metric value.")
      }
    });
  }, []);

  const taskList = useMemo(() => {
    return exposeComponent(TaskList, {
      description: "Displays a checklist of next actions.",
      name: "TaskList",
      props: {
        items: s.array("Action items.", s.string("Action text.")),
        title: s.string("Checklist title.")
      }
    });
  }, []);

  const uiKit = useUiKit({
    components: [statusPill, statCard, taskList]
  });

  const genUi = useGenUi({
    kit: uiKit,
    outlet: "voice-main",
    toolNames: ["render_ui"]
  });

  const lookupOrderEtaTool = useTool({
    deps: [],
    description:
      "Return ETA details for a delivery order when provided an order identifier.",
    handler: async (
      input: { orderId: string },
      abortSignal: AbortSignal
    ): Promise<unknown> => {
      await waitFor(300, abortSignal);

      return {
        confidence: "high",
        etaMinutes: 14,
        orderId: input.orderId.toUpperCase(),
        route: "Warehouse 7 -> Mission District"
      };
    },
    name: "lookup_order_eta",
    schema: s.object("Order lookup input.", {
      orderId: s.string("Unique order identifier.")
    })
  });

  const renderUiTool = useTool({
    deps: [],
    description:
      "Accept generated UI payload and acknowledge render intent for the outlet.",
    handler: (input: { ui: Record<string, unknown>[] }): Promise<unknown> => {
      return Promise.resolve({
        accepted: true,
        componentCount: input.ui.length
      });
    },
    name: "render_ui",
    schema: s.object("UI wrapper payload.", {
      ui: s.array("UI nodes array.", s.object("Arbitrary node payload.", {}))
    })
  });

  const toolRegistrations = useVoiceAgentTools({
    lookupOrderEtaTool,
    renderUiTool
  });

  if (config.isLoading) {
    return (
      <main className="app-shell">
        <section className="panel">
          <h1>Frenchfry Demo</h1>
          <p>Loading demo server configuration...</p>
        </section>
      </main>
    );
  }

  if (config.error !== undefined || config.realtimeWebSocketUrl === undefined) {
    return (
      <main className="app-shell">
        <section className="panel">
          <h1>Frenchfry Demo</h1>
          <p className="error-line">
            Failed to load server config:{" "}
            {config.error ?? "Missing websocket URL."}
          </p>
          <p className="muted">
            Expected server endpoint: {serverHttpUrl}/config
          </p>
        </section>
      </main>
    );
  }

  return (
    <FrenchfryProvider onWarning={handleWarning}>
      <main className="app-shell">
        <header className="hero">
          <h1>Frenchfry Voice + Generative UI Demo</h1>
          <p>
            Runtime websocket: <code>{config.realtimeWebSocketUrl}</code>
          </p>
        </header>
        <VoiceAgent
          genUi={[genUi]}
          tools={toolRegistrations.voiceAgentTools}
          url={config.realtimeWebSocketUrl}
        >
          {() => {
            return (
              <AgentConsole sessionTools={toolRegistrations.sessionTools} />
            );
          }}
        </VoiceAgent>
        <section className="panel">
          <h2>Generated UI Outlet</h2>
          <VoiceUiOutlet
            fallback={
              <p className="muted">
                Ask by voice for an order update and request a status dashboard.
              </p>
            }
            name="voice-main"
          />
        </section>
        <section className="panel">
          <h2>Runtime Log</h2>
          {logs.length === 0 ? (
            <p className="muted">No warnings yet.</p>
          ) : (
            <ul className="log-list">
              {logs.map((entry) => {
                return (
                  <li key={entry.id}>
                    <strong>{entry.level.toUpperCase()}</strong> [
                    {entry.timestamp}] {entry.message}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </FrenchfryProvider>
  );
};

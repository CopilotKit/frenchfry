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
  realtimeSessionUrl: z.string().url()
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
 * Fetches and validates runtime session configuration from the demo server.
 *
 * @param serverHttpUrl HTTP URL of the demo server.
 * @returns Loading, error, and resolved session URL state.
 */
const useDemoServerConfig = (
  serverHttpUrl: string
): {
  error?: string;
  isLoading: boolean;
  realtimeSessionUrl?: string;
} => {
  const [state, setState] = useState<{
    error?: string;
    isLoading: boolean;
    realtimeSessionUrl?: string;
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
          realtimeSessionUrl: config.realtimeSessionUrl
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
 * Renders the interactive voice-first agent console.
 *
 * @returns Console UI element.
 */
const AgentConsole = (): ReactElement => {
  const voiceAgent = useVoiceAgent();

  if (voiceAgent === null) {
    return (
      <section className="panel">
        <h2>Agent Console</h2>
        <p>Voice agent context is not available.</p>
      </section>
    );
  }

  useEffect(() => {
    if (!voiceAgent.isRunning || voiceAgent.voiceInputStatus !== "idle") {
      return;
    }

    void voiceAgent.startVoiceInput();
  }, [
    voiceAgent.isRunning,
    voiceAgent.startVoiceInput,
    voiceAgent.voiceInputStatus
  ]);

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
          Start Listening
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
          Stop Listening
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
    deps: [appendLog],
    description:
      "Return ETA details for a delivery order when provided an order identifier.",
    handler: async (
      input: { orderId: string },
      abortSignal: AbortSignal
    ): Promise<unknown> => {
      await waitFor(300, abortSignal);
      appendLog("info", `Tool lookup_order_eta called for ${input.orderId}.`);

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
  const tools = useMemo<readonly [typeof lookupOrderEtaTool]>(() => {
    return [lookupOrderEtaTool];
  }, [lookupOrderEtaTool]);

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

  if (config.error !== undefined || config.realtimeSessionUrl === undefined) {
    return (
      <main className="app-shell">
        <section className="panel">
          <h1>Frenchfry Demo</h1>
          <p className="error-line">
            Failed to load server config:{" "}
            {config.error ?? "Missing session URL."}
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
            Runtime session endpoint: <code>{config.realtimeSessionUrl}</code>
          </p>
        </header>
        <VoiceAgent
          genUi={[genUi]}
          session={{
            audio: {
              input: {
                turn_detection: {
                  create_response: true,
                  interrupt_response: true,
                  type: "server_vad"
                }
              },
              output: {
                voice: "marin"
              }
            },
            instructions:
              "You are a concise voice support agent. Use tools when they help answer the user.",
            model: "gpt-realtime",
            output_modalities: ["audio"],
            tool_choice: "auto",
            type: "realtime"
          }}
          sessionEndpoint={config.realtimeSessionUrl}
          tools={tools}
        >
          {() => {
            return <AgentConsole />;
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

import {
  FrenchfryProvider,
  VoiceAgent,
  VoiceUiOutlet,
  useGenUi,
  useTool,
  useUiKit,
  useVoiceAgent
} from "@frenchfryai/react";
import { s } from "@hashbrownai/core";
import { exposeComponent } from "@hashbrownai/react";
import { type ReactElement } from "react";

import "./app.css";

type StatusTone = "critical" | "healthy" | "watch";

const runtimeUrl = "http://localhost:8787";
const generatedUiOutlet = "voice-main";

/**
 * Determines whether a runtime value is a plain object map.
 *
 * @param value Runtime value.
 * @returns True when value is a plain object map.
 */
const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

/**
 * Reads a string property from a plain object.
 *
 * @param value Candidate object value.
 * @param key Property key.
 * @returns String property value when present.
 */
const readString = (
  value: Record<string, unknown>,
  key: string
): string | undefined => {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
};

/**
 * Parses a status tone value from an unknown input.
 *
 * @param value Runtime value.
 * @returns Status tone when valid.
 */
const toStatusTone = (value: unknown): StatusTone | undefined => {
  return value === "critical" || value === "healthy" || value === "watch"
    ? value
    : undefined;
};

/**
 * Renders a compact status badge for generated UI.
 *
 * @param props Badge label and tone.
 * @returns Styled badge element.
 */
const StatusPill = (props: unknown): ReactElement => {
  if (!isRecord(props)) {
    return <span className="status-pill tone-watch">Invalid StatusPill props</span>;
  }

  const label = readString(props, "label");
  const tone = toStatusTone(props.tone);
  if (label === undefined || tone === undefined) {
    return <span className="status-pill tone-watch">Invalid StatusPill props</span>;
  }

  return (
    <span className={`status-pill tone-${tone}`}>{label}</span>
  );
};

/**
 * Renders a generated metric card.
 *
 * @param props Card label, value, and visual tone.
 * @returns Metric card element.
 */
const StatCard = (props: unknown): ReactElement => {
  if (!isRecord(props)) {
    return (
      <article className="stat-card tone-watch">
        <p className="stat-label">Invalid StatCard props</p>
      </article>
    );
  }

  const label = readString(props, "label");
  const tone = toStatusTone(props.tone);
  const value = readString(props, "value");
  if (label === undefined || tone === undefined || value === undefined) {
    return (
      <article className="stat-card tone-watch">
        <p className="stat-label">Invalid StatCard props</p>
      </article>
    );
  }

  return (
    <article className={`stat-card tone-${tone}`}>
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
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
  if (!isRecord(props)) {
    return (
      <section className="task-list">
        <h3>Invalid TaskList props</h3>
      </section>
    );
  }

  const title = readString(props, "title");
  const items =
    Array.isArray(props.items) && props.items.every((item) => typeof item === "string")
      ? props.items
      : undefined;
  if (title === undefined || items === undefined) {
    return (
      <section className="task-list">
        <h3>Invalid TaskList props</h3>
      </section>
    );
  }

  return (
    <section className="task-list">
      <h3>{title}</h3>
      <ul>
        {items.map((item) => {
          return <li key={item}>{item}</li>;
        })}
      </ul>
    </section>
  );
};

const statusPillComponent = exposeComponent(StatusPill, {
  description: "Displays a concise service health badge.",
  name: "StatusPill",
  props: {
    label: s.string("Short status label."),
    tone: s.enumeration("Visual severity tone.", ["critical", "healthy", "watch"])
  }
});

const statCardComponent = exposeComponent(StatCard, {
  description: "Displays a metric label and value card.",
  name: "StatCard",
  props: {
    label: s.string("Metric label."),
    tone: s.enumeration("Visual severity tone.", ["critical", "healthy", "watch"]),
    value: s.string("Metric value.")
  }
});

const taskListComponent = exposeComponent(TaskList, {
  description: "Displays a checklist of next actions.",
  name: "TaskList",
  props: {
    items: s.array("Action items.", s.string("Action text.")),
    title: s.string("Checklist title.")
  }
});

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
          disabled={!voiceAgent.canConnect}
          onClick={voiceAgent.start}
          type="button"
        >
          Connect
        </button>
        <button
          className="secondary"
          disabled={!voiceAgent.canDisconnect}
          onClick={voiceAgent.stop}
          type="button"
        >
          Disconnect
        </button>
      </div>
      <div className="button-row">
        <button
          className="primary"
          disabled={!voiceAgent.canStartVoiceInput}
          onClick={() => {
            void voiceAgent.startVoiceInput();
          }}
          type="button"
        >
          Start Listening
        </button>
        <button
          className="secondary"
          disabled={!voiceAgent.canStopVoiceInput}
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
  const uiKit = useUiKit({
    components: [statusPillComponent, statCardComponent, taskListComponent]
  });

  const genUi = useGenUi({
    kit: uiKit,
    outlet: generatedUiOutlet,
    toolNames: ["render_ui"]
  });

  const lookupOrderEtaTool = useTool({
    deps: [],
    description:
      "Return ETA details for a delivery order when provided an order identifier.",
    handler: (input: { orderId: string }): Promise<unknown> => {
      return Promise.resolve({
        confidence: "high",
        etaMinutes: 14,
        orderId: input.orderId.toUpperCase(),
        route: "Warehouse 7 -> Mission District"
      });
    },
    name: "lookup_order_eta",
    schema: s.object("Order lookup input.", {
      orderId: s.string("Unique order identifier.")
    })
  });

  return (
    <FrenchfryProvider>
      <main className="app-shell">
        <header className="hero">
          <h1>Frenchfry Voice + Generative UI Demo</h1>
          <p>
            Runtime endpoint: <code>{runtimeUrl}</code>
          </p>
        </header>
        <VoiceAgent
          autoStartVoiceInput
          genUi={[genUi]}
          runtimeUrl={runtimeUrl}
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
          tools={[lookupOrderEtaTool]}
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
            name={generatedUiOutlet}
          />
        </section>
      </main>
    </FrenchfryProvider>
  );
};

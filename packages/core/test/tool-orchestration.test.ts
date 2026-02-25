import { expect, test } from "vitest";

import {
  createFunctionCallOutputEvents,
  createToolCallAccumulatorState,
  createToolRegistry,
  reduceToolCallAccumulatorState,
  runToolInvocation,
  shouldInvokeToolCall,
  type OrchestrationTool
} from "../src/tool-orchestration";

test("accumulator appends deltas and marks done", () => {
  // Arrange
  const initial = createToolCallAccumulatorState();

  // Act
  const afterDelta = reduceToolCallAccumulatorState(
    initial,
    {
      call_id: "call_1",
      delta: '{"city":"San',
      item_id: "item_1",
      output_index: 0,
      response_id: "response_1",
      type: "response.function_call_arguments.delta"
    },
    100
  );

  const afterDone = reduceToolCallAccumulatorState(
    afterDelta,
    {
      arguments: '{"city":"San Francisco"}',
      call_id: "call_1",
      item_id: "item_1",
      name: "lookup_weather",
      output_index: 0,
      response_id: "response_1",
      type: "response.function_call_arguments.done"
    },
    200
  );

  // Assert
  expect(afterDone.callsById.call_1).toEqual({
    argumentText: '{"city":"San',
    callId: "call_1",
    doneArguments: '{"city":"San Francisco"}',
    isDone: true,
    itemId: "item_1",
    name: "lookup_weather",
    responseId: "response_1",
    updatedAtMs: 200
  });
});

test("accumulator keeps optional fields when additional deltas arrive", () => {
  // Arrange
  const initial = createToolCallAccumulatorState();
  const afterDone = reduceToolCallAccumulatorState(
    initial,
    {
      arguments: '{"first":true}',
      call_id: "call_optional",
      item_id: "item_optional",
      name: "tool_with_name",
      output_index: 0,
      response_id: "response_optional",
      type: "response.function_call_arguments.done"
    },
    100
  );

  // Act
  const afterDelta = reduceToolCallAccumulatorState(
    afterDone,
    {
      call_id: "call_optional",
      delta: ',"next":true}',
      item_id: "item_optional",
      output_index: 0,
      response_id: "response_optional",
      type: "response.function_call_arguments.delta"
    },
    200
  );

  // Assert
  expect(afterDelta.callsById.call_optional).toEqual({
    argumentText: '{"first":true},"next":true}',
    callId: "call_optional",
    doneArguments: '{"first":true}',
    isDone: true,
    itemId: "item_optional",
    name: "tool_with_name",
    responseId: "response_optional",
    updatedAtMs: 200
  });
});

test("done events can omit name without setting optional field", () => {
  // Arrange
  const initial = createToolCallAccumulatorState();

  // Act
  const afterDone = reduceToolCallAccumulatorState(
    initial,
    {
      arguments: "{}",
      call_id: "call_noname",
      item_id: "item_noname",
      output_index: 0,
      response_id: "response_noname",
      type: "response.function_call_arguments.done"
    },
    1
  );

  // Assert
  expect(afterDone.callsById.call_noname?.name).toBeUndefined();
});

test("accumulator falls back to call defaults when event metadata is omitted", () => {
  // Arrange
  const initial = createToolCallAccumulatorState();

  // Act
  const afterDelta = reduceToolCallAccumulatorState(
    initial,
    {
      call_id: "call_minimal",
      delta: '{"ui":[]}',
      type: "response.function_call_arguments.delta"
    },
    10
  );
  const afterDone = reduceToolCallAccumulatorState(
    afterDelta,
    {
      arguments: '{"ui":[]}',
      call_id: "call_minimal",
      type: "response.function_call_arguments.done"
    },
    20
  );

  // Assert
  expect(afterDone.callsById.call_minimal).toEqual({
    argumentText: '{"ui":[]}',
    callId: "call_minimal",
    doneArguments: '{"ui":[]}',
    isDone: true,
    itemId: "call_minimal",
    responseId: "unknown_response",
    updatedAtMs: 20
  });
});

test("accumulator reuses previous metadata when later events omit metadata", () => {
  // Arrange
  const initial = createToolCallAccumulatorState();
  const afterFirstDelta = reduceToolCallAccumulatorState(
    initial,
    {
      call_id: "call_reuse",
      delta: '{"ui":[',
      item_id: "item_reuse",
      response_id: "response_reuse",
      type: "response.function_call_arguments.delta"
    },
    1
  );

  // Act
  const afterSecondDelta = reduceToolCallAccumulatorState(
    afterFirstDelta,
    {
      call_id: "call_reuse",
      delta: "]}",
      type: "response.function_call_arguments.delta"
    },
    2
  );
  const afterDone = reduceToolCallAccumulatorState(
    afterSecondDelta,
    {
      arguments: '{"ui":[]}',
      call_id: "call_reuse",
      type: "response.function_call_arguments.done"
    },
    3
  );

  // Assert
  expect(afterDone.callsById.call_reuse).toEqual({
    argumentText: '{"ui":[]}',
    callId: "call_reuse",
    doneArguments: '{"ui":[]}',
    isDone: true,
    itemId: "item_reuse",
    responseId: "response_reuse",
    updatedAtMs: 3
  });
});

test("accumulator uses mixed metadata sources when only part of done metadata is present", () => {
  // Arrange
  const initial = createToolCallAccumulatorState();
  const afterDelta = reduceToolCallAccumulatorState(
    initial,
    {
      call_id: "call_mixed",
      delta: '{"ok":true}',
      item_id: "item_from_delta",
      type: "response.function_call_arguments.delta"
    },
    1
  );

  // Act
  const afterDone = reduceToolCallAccumulatorState(
    afterDelta,
    {
      arguments: '{"ok":true}',
      call_id: "call_mixed",
      response_id: "response_from_done",
      type: "response.function_call_arguments.done"
    },
    2
  );

  // Assert
  expect(afterDone.callsById.call_mixed).toEqual({
    argumentText: '{"ok":true}',
    callId: "call_mixed",
    doneArguments: '{"ok":true}',
    isDone: true,
    itemId: "item_from_delta",
    responseId: "response_from_done",
    updatedAtMs: 2
  });
});

test("accumulator returns original state for unrelated events", () => {
  // Arrange
  const initial = createToolCallAccumulatorState();

  // Act
  const next = reduceToolCallAccumulatorState(
    initial,
    {
      foo: "bar",
      type: "response.text.delta"
    },
    1
  );

  // Assert
  expect(next).toBe(initial);
});

test("shouldInvokeToolCall returns true when call has not been marked done", () => {
  // Arrange
  const state = createToolCallAccumulatorState();

  // Act
  const result = shouldInvokeToolCall(state, {
    arguments: '{"ok":true}',
    call_id: "call_new",
    type: "response.function_call_arguments.done"
  });

  // Assert
  expect(result).toBe(true);
});

test("shouldInvokeToolCall returns false for duplicate done arguments", () => {
  // Arrange
  const state = reduceToolCallAccumulatorState(
    createToolCallAccumulatorState(),
    {
      arguments: '{"ok":true}',
      call_id: "call_duplicate",
      type: "response.function_call_arguments.done"
    },
    1
  );

  // Act
  const result = shouldInvokeToolCall(state, {
    arguments: '{"ok":true}',
    call_id: "call_duplicate",
    type: "response.function_call_arguments.done"
  });

  // Assert
  expect(result).toBe(false);
});

test("shouldInvokeToolCall returns true when duplicate done adds missing name", () => {
  // Arrange
  const state = reduceToolCallAccumulatorState(
    createToolCallAccumulatorState(),
    {
      arguments: '{"ok":true}',
      call_id: "call_upgrade",
      type: "response.function_call_arguments.done"
    },
    1
  );

  // Act
  const result = shouldInvokeToolCall(state, {
    arguments: '{"ok":true}',
    call_id: "call_upgrade",
    name: "render_ui",
    type: "response.function_call_arguments.done"
  });

  // Assert
  expect(result).toBe(true);
});

test("reduceDone preserves previous name when done event omits it", () => {
  // Arrange
  const initialWithName = reduceToolCallAccumulatorState(
    createToolCallAccumulatorState(),
    {
      arguments: '{"ok":true}',
      call_id: "call_name",
      name: "lookup_order_eta",
      type: "response.function_call_arguments.done"
    },
    1
  );

  // Act
  const next = reduceToolCallAccumulatorState(
    initialWithName,
    {
      arguments: '{"ok":true}',
      call_id: "call_name",
      type: "response.function_call_arguments.done"
    },
    2
  );

  // Assert
  expect(next.callsById.call_name?.name).toBe("lookup_order_eta");
});

test("runToolInvocation returns unknown_tool when no tool exists", async () => {
  // Arrange
  const toolsByName = createToolRegistry([]);

  // Act
  const result = await runToolInvocation({
    doneEvent: {
      arguments: "{}",
      call_id: "call_missing",
      item_id: "item_missing",
      name: "does_not_exist",
      output_index: 0,
      response_id: "response_missing",
      type: "response.function_call_arguments.done"
    },
    timeoutMs: 100,
    toolsByName
  });

  // Assert
  expect(result.status).toBe("unknown_tool");
  expect(result.output.ok).toBe(false);
});

test("runToolInvocation returns unknown_tool fallback name when tool name is missing", async () => {
  // Arrange
  const toolsByName = createToolRegistry([]);

  // Act
  const result = await runToolInvocation({
    doneEvent: {
      arguments: "{}",
      call_id: "call_missing_name",
      type: "response.function_call_arguments.done"
    },
    timeoutMs: 100,
    toolsByName
  });

  // Assert
  expect(result.status).toBe("unknown_tool");
  expect(result.output.error?.message).toContain('"unknown"');
});

test("runToolInvocation returns invalid_arguments for malformed json", async () => {
  // Arrange
  const tool: OrchestrationTool = {
    description: "No-op",
    handler: () => {
      return Promise.resolve("ok");
    },
    name: "noop"
  };

  // Act
  const result = await runToolInvocation({
    doneEvent: {
      arguments: "{",
      call_id: "call_invalid",
      item_id: "item_invalid",
      name: "noop",
      output_index: 0,
      response_id: "response_invalid",
      type: "response.function_call_arguments.done"
    },
    timeoutMs: 100,
    toolsByName: createToolRegistry([tool])
  });

  // Assert
  expect(result.status).toBe("invalid_arguments");
  expect(result.output.ok).toBe(false);
});

test("runToolInvocation returns success for resolved handlers", async () => {
  // Arrange
  const tool: OrchestrationTool = {
    description: "Echo",
    handler: (input: unknown) => {
      return Promise.resolve({
        echoed: input
      });
    },
    name: "echo"
  };

  // Act
  const result = await runToolInvocation({
    doneEvent: {
      arguments: '{"value":123}',
      call_id: "call_success",
      item_id: "item_success",
      name: "echo",
      output_index: 0,
      response_id: "response_success",
      type: "response.function_call_arguments.done"
    },
    timeoutMs: 100,
    toolsByName: createToolRegistry([tool])
  });

  // Assert
  expect(result.status).toBe("success");
  expect(result.output.ok).toBe(true);
  expect(result.output.data).toEqual({
    echoed: {
      value: 123
    }
  });
});

test("runToolInvocation supports empty argument payloads", async () => {
  // Arrange
  const tool: OrchestrationTool = {
    description: "No input tool",
    handler: (input: unknown) => {
      return Promise.resolve({
        received: input
      });
    },
    name: "no_input"
  };

  // Act
  const result = await runToolInvocation({
    doneEvent: {
      arguments: "   ",
      call_id: "call_empty_args",
      item_id: "item_empty_args",
      name: "no_input",
      output_index: 0,
      response_id: "response_empty_args",
      type: "response.function_call_arguments.done"
    },
    timeoutMs: 100,
    toolsByName: createToolRegistry([tool])
  });

  // Assert
  expect(result.status).toBe("success");
  expect(result.output.ok).toBe(true);
  expect(result.output.data).toEqual({
    received: undefined
  });
});

test("runToolInvocation returns tool_error when handler rejects", async () => {
  // Arrange
  const tool: OrchestrationTool = {
    description: "Rejects",
    handler: () => {
      return Promise.reject(new Error("failure"));
    },
    name: "reject"
  };

  // Act
  const result = await runToolInvocation({
    doneEvent: {
      arguments: "{}",
      call_id: "call_error",
      item_id: "item_error",
      name: "reject",
      output_index: 0,
      response_id: "response_error",
      type: "response.function_call_arguments.done"
    },
    timeoutMs: 100,
    toolsByName: createToolRegistry([tool])
  });

  // Assert
  expect(result.status).toBe("tool_error");
  expect(result.output.ok).toBe(false);
  expect(result.output.error?.message).toBe("failure");
});

test("runToolInvocation falls back to default error message for non-Error throws", async () => {
  // Arrange
  const tool: OrchestrationTool = {
    description: "Throws empty error message",
    handler: () => {
      throw new Error("");
    },
    name: "throws_unknown"
  };

  // Act
  const result = await runToolInvocation({
    doneEvent: {
      arguments: "{}",
      call_id: "call_unknown_error",
      item_id: "item_unknown_error",
      name: "throws_unknown",
      output_index: 0,
      response_id: "response_unknown_error",
      type: "response.function_call_arguments.done"
    },
    timeoutMs: 100,
    toolsByName: createToolRegistry([tool])
  });

  // Assert
  expect(result.status).toBe("tool_error");
  expect(result.output.error?.message).toBe("Tool execution failed.");
});

test("runToolInvocation returns timeout when handler exceeds timeout", async () => {
  // Arrange
  const tool: OrchestrationTool = {
    description: "Sleeps",
    handler: async (_input: unknown, abortSignal: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          resolve();
        }, 1000);

        abortSignal.addEventListener(
          "abort",
          () => {
            clearTimeout(timeoutId);
            reject(new Error("aborted"));
          },
          {
            once: true
          }
        );
      });

      return "never";
    },
    name: "sleep"
  };

  // Act
  const result = await runToolInvocation({
    doneEvent: {
      arguments: "{}",
      call_id: "call_timeout",
      item_id: "item_timeout",
      name: "sleep",
      output_index: 0,
      response_id: "response_timeout",
      type: "response.function_call_arguments.done"
    },
    timeoutMs: 10,
    toolsByName: createToolRegistry([tool])
  });

  // Assert
  expect(result.status).toBe("tool_timeout");
  expect(result.output.ok).toBe(false);
});

test("createFunctionCallOutputEvents emits output and response.create by default", () => {
  // Arrange
  const callId = "call_events";

  // Act
  const events = createFunctionCallOutputEvents({
    callId,
    output: {
      data: {
        city: "San Francisco"
      },
      ok: true
    }
  });

  // Assert
  expect(events).toHaveLength(2);
  expect(events.at(0)).toEqual({
    item: {
      call_id: "call_events",
      output: JSON.stringify({
        data: {
          city: "San Francisco"
        },
        ok: true
      }),
      type: "function_call_output"
    },
    type: "conversation.item.create"
  });
  expect(events.at(1)).toEqual({
    response: {},
    type: "response.create"
  });
});

test("createFunctionCallOutputEvents can skip response.create", () => {
  // Arrange
  const callId = "call_no_response";

  // Act
  const events = createFunctionCallOutputEvents({
    autoResponse: false,
    callId,
    output: {
      ok: true
    }
  });

  // Assert
  expect(events).toHaveLength(1);
  expect(events.at(0)).toEqual({
    item: {
      call_id: "call_no_response",
      output: JSON.stringify({
        ok: true
      }),
      type: "function_call_output"
    },
    type: "conversation.item.create"
  });
});

import { expect, test } from "vitest";

import { SERVER_DEMO_NAME, startupMessage } from "../src/index";

test("demo server scaffold exports a stable marker", () => {
  // Arrange
  const expectedName = "@frenchfryai/demo-server";

  // Act
  const actualName = SERVER_DEMO_NAME;

  // Assert
  expect(actualName).toBe(expectedName);
});

test("demo server scaffold startup message contains runtime linkage", () => {
  // Arrange
  const expectedFragment = "@frenchfryai/runtime";

  // Act
  const actualMessage = startupMessage;

  // Assert
  expect(actualMessage.includes(expectedFragment)).toBe(true);
});

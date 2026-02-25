import { expect, test } from "vitest";

import {
  FrenchfryProvider,
  REACT_PACKAGE_NAME,
  VoiceAgent,
  VoiceUiOutlet,
  useGenUi,
  useJsonParser,
  useTool,
  useUiKit,
  useVoiceAgent
} from "../src/index";

test("react package exposes a stable name marker", () => {
  // Arrange
  const expectedName = "@frenchfryai/react";

  // Act
  const actualName = REACT_PACKAGE_NAME;

  // Assert
  expect(actualName).toBe(expectedName);
});

test("react package exports provider, agent, outlet, and hook entry points", () => {
  // Arrange
  const expectedType = "function";

  // Act
  const observed = [
    FrenchfryProvider,
    VoiceAgent,
    VoiceUiOutlet,
    useGenUi,
    useVoiceAgent,
    useTool,
    useUiKit,
    useJsonParser
  ] as const;

  // Assert
  observed.forEach((entry) => {
    expect(typeof entry).toBe(expectedType);
  });
});

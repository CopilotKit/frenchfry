import { expect, test } from "vitest";

import { RUNTIME_PACKAGE_NAME } from "../src/index";

test("runtime package exposes a stable name marker", () => {
  // Arrange
  const expectedName = "@frenchfryai/runtime";

  // Act
  const actualName = RUNTIME_PACKAGE_NAME;

  // Assert
  expect(actualName).toBe(expectedName);
});

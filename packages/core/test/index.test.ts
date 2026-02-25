import { expect, test } from "vitest";

import { CORE_PACKAGE_NAME } from "../src/index";

test("core package exposes a stable name marker", () => {
  // Arrange
  const expectedName = "@frenchfryai/core";

  // Act
  const actualName = CORE_PACKAGE_NAME;

  // Assert
  expect(actualName).toBe(expectedName);
});

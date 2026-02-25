import { expect, test } from "vitest";

import { REACT_PACKAGE_NAME } from "../src/index";

test("react package exposes a stable name marker", () => {
  // Arrange
  const expectedName = "@frenchfryai/react";

  // Act
  const actualName = REACT_PACKAGE_NAME;

  // Assert
  expect(actualName).toBe(expectedName);
});

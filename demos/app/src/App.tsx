import type { ReactElement } from "react";

import { REACT_PACKAGE_NAME } from "@frenchfryai/react";

/**
 * Renders the initial demo shell placeholder.
 *
 * @returns A static scaffold view for the demo application.
 */
export const App = (): ReactElement => {
  return (
    <main>
      <h1>Frenchfry Demo</h1>
      <p>Scaffold ready. Package loaded: {REACT_PACKAGE_NAME}</p>
    </main>
  );
};

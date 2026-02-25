import {
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useState
} from "react";

import { FrenchfryUiContext } from "./frenchfry-provider";

/**
 * Represents props for rendering an outlet target in the React tree.
 */
export type VoiceUiOutletProps = {
  fallback?: ReactNode;
  name: string;
};

/**
 * Renders UI emitted by generative pipelines targeting a named outlet.
 *
 * @param props Outlet props.
 * @returns Rendered outlet content.
 */
export const VoiceUiOutlet = (props: VoiceUiOutletProps): ReactElement => {
  const uiBus = useContext(FrenchfryUiContext);
  const [elements, setElements] = useState<ReactElement[] | null>(null);

  useEffect(() => {
    if (uiBus === null) {
      return;
    }

    return uiBus.registerOutlet(props.name, (nextElements) => {
      setElements(nextElements);
    });
  }, [props.name, uiBus]);

  if (elements === null || elements.length === 0) {
    return <>{props.fallback ?? null}</>;
  }

  return <>{elements}</>;
};

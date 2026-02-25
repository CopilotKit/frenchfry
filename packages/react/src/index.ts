export const REACT_PACKAGE_NAME = "@frenchfryai/react";

export type ReactPackageName = typeof REACT_PACKAGE_NAME;

export {
  useJsonParser,
  useTool,
  useUiKit,
  type ExposedComponent,
  type ToolOptions,
  type UiKit
} from "@hashbrownai/react";

export {
  FrenchfryProvider,
  FrenchfryUiContext,
  type FrenchfryProviderProps,
  type FrenchfryWarning
} from "./frenchfry-provider";

export {
  useGenUi,
  type GenUiRegistration,
  type UseGenUiOptions
} from "./use-gen-ui";

export {
  useVoiceAgent,
  VoiceAgentContext,
  type ActiveToolCallState,
  type VoiceAgentRenderState
} from "./use-voice-agent";

export { VoiceAgent, type VoiceAgentProps } from "./voice-agent";

export { VoiceUiOutlet, type VoiceUiOutletProps } from "./voice-ui-outlet";

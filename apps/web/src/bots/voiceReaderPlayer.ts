import { createVoiceReaderTransport } from "@t3tools/client-runtime/state/bots";
import { createVoiceReaderPlayer } from "@t3tools/client-runtime/voice-reader";

import { toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { botsEnvironment } from "../state/bots";
import { openBrowserVoiceReaderPeer } from "./voiceReaderPeer";

/** The page's only voice reader: starting a message stops the one playing. */
export const voiceReaderPlayer = createVoiceReaderPlayer({
  openPeer: openBrowserVoiceReaderPeer,
  transport: createVoiceReaderTransport(appAtomRegistry, botsEnvironment),
  onError: (description) =>
    toastManager.add({ type: "error", title: "The voice reader failed", description }),
});

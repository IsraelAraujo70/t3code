import { createVoiceReaderTransport } from "@t3tools/client-runtime/state/bots";
import { createVoiceReaderPlayer } from "@t3tools/client-runtime/voice-reader";

import * as Dialog from "../components/ui/Dialog";
import { appAtomRegistry } from "../state/atom-registry";
import { botsEnvironment } from "./state";
import { openNativeVoiceReaderPeer } from "./voiceReaderPeer";

/** The app's only voice reader: starting a message stops the one playing. */
export const voiceReaderPlayer = createVoiceReaderPlayer({
  openPeer: openNativeVoiceReaderPeer,
  transport: createVoiceReaderTransport(appAtomRegistry, botsEnvironment),
  onError: (description) => Dialog.alert("Falha ao ler a resposta", description),
});

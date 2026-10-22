import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, REALTIME_VOICES, type RealtimeVoice } from "@t3tools/contracts";
import { PauseIcon, PlayIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { searchableSetting } from "../components/settings/settingsSearch";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Radio, RadioGroup } from "../components/ui/radio-group";
import { reportCommandResult } from "./botsSettingsShared";

/**
 * One reply read by each voice, recorded on the bots host and served over its tailnet. Outside the
 * tailnet a sample does not load, and only the preview is lost.
 */
const SAMPLES_URL = "https://omarchy.taild92f5b.ts.net/vozes/";

/** The radio value for an unset setting; voices never contain a colon. */
const SERVER_DEFAULT = "server:default";

/**
 * Settings → Bots → Voice. Edits the voice of voice sessions on the bots host. The next read uses
 * it, and an open conversation switches to it once the voice falls quiet.
 */
export function VoiceSettingsSection({
  environmentId,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
}) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const canUpdate = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "voice update",
  });
  const [saving, setSaving] = useState(false);
  const [playing, setPlaying] = useState<RealtimeVoice | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);

  const current = settings?.voiceReaderVoice ?? null;

  const choose = async (value: string) => {
    if (saving) return;
    const voiceReaderVoice = REALTIME_VOICES.find((voice) => voice === value) ?? null;
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { voiceReaderVoice } },
    });
    setSaving(false);
    reportCommandResult("Could not change the voice", result);
  };

  const preview = (voice: RealtimeVoice) => {
    audio.current?.pause();
    if (playing === voice) {
      setPlaying(null);
      return;
    }
    const sample = new Audio(`${SAMPLES_URL}${voice}.webm`);
    audio.current = sample;
    setPlaying(voice);
    const stop = () => setPlaying((value) => (value === voice ? null : value));
    sample.addEventListener("ended", stop);
    sample.addEventListener("error", stop);
    sample.play().catch(stop);
  };

  return (
    <SettingsSection {...searchableSetting("bots-voice")}>
      <SettingsRow
        title="Voice"
        description="Reads replies aloud and talks in voice conversations. A new voice applies at once, also to a conversation already open."
      >
        <RadioGroup
          aria-label="Voice"
          value={current ?? SERVER_DEFAULT}
          disabled={!connected || !canUpdate || saving || settings === null}
          onValueChange={(value) => void choose(String(value))}
        >
          <label className="flex min-h-8 items-center gap-3 text-sm">
            <Radio value={SERVER_DEFAULT} />
            <span>Server default</span>
            <span className="text-xs text-muted-foreground">
              T3CODE_VOICE_READER_VOICE, else cove
            </span>
          </label>
          {REALTIME_VOICES.map((voice) => (
            <div key={voice} className="flex min-h-8 items-center gap-3">
              <label className="flex flex-1 items-center gap-3 text-sm capitalize">
                <Radio value={voice} />
                {voice}
              </label>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={playing === voice ? `Stop ${voice}` : `Listen to ${voice}`}
                onClick={() => preview(voice)}
              >
                {playing === voice ? <PauseIcon /> : <PlayIcon />}
              </Button>
            </div>
          ))}
        </RadioGroup>
      </SettingsRow>
    </SettingsSection>
  );
}

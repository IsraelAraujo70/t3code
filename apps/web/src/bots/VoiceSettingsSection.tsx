import { useAtomValue } from "@effect/atom-react";
import {
  type BotsHostStatus,
  type EnvironmentId,
  REALTIME_VOICES,
  type RealtimeVoice,
  VOICE_LANGUAGES,
  type VoiceLanguage,
} from "@t3tools/contracts";
import { PauseIcon, PlayIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { searchableSetting } from "../components/settings/settingsSearch";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Radio, RadioGroup } from "../components/ui/radio-group";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { reportCommandResult } from "./botsSettingsShared";

/** The radio and select value for an unset setting; voices and languages never contain a colon. */
const SERVER_DEFAULT = "server:default";

const LANGUAGE_LABELS: Readonly<Record<VoiceLanguage, string>> = {
  en: "English",
  "pt-BR": "Português (Brasil)",
};

/**
 * Settings → Bots → Voice. Edits the voice of voice sessions on the bots host and the language it
 * speaks. A new voice applies to the next read and to an open conversation once it falls quiet; a
 * new language applies from the next session. `host` is absent on servers built before it.
 */
export function VoiceSettingsSection({
  environmentId,
  connected,
  host,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly host: BotsHostStatus | undefined;
}) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const canUpdate = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "voice update",
  });
  const [saving, setSaving] = useState(false);
  const [playing, setPlaying] = useState<RealtimeVoice | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Stops the voice sample's audio element on unmount.
  useEffect(() => () => audio.current?.pause(), []);

  const current = settings?.voiceReaderVoice ?? null;
  const currentLanguage = settings?.voiceLanguage ?? null;
  const samplesUrl = host?.voiceSamplesUrl ?? null;
  const disabled = !connected || !canUpdate || saving || settings === null;

  const save = async (
    patch: { voiceReaderVoice: RealtimeVoice | null } | { voiceLanguage: VoiceLanguage | null },
    failure: string,
  ) => {
    if (saving) return;
    setSaving(true);
    const result = await updateSettings({ environmentId, input: { patch } });
    setSaving(false);
    reportCommandResult(failure, result);
  };
  const choose = (value: string) =>
    save(
      { voiceReaderVoice: REALTIME_VOICES.find((voice) => voice === value) ?? null },
      "Could not change the voice",
    );
  const chooseLanguage = (value: string) =>
    save(
      { voiceLanguage: VOICE_LANGUAGES.find((language) => language === value) ?? null },
      "Could not change the language",
    );

  const preview = (voice: RealtimeVoice) => {
    audio.current?.pause();
    if (playing === voice) {
      setPlaying(null);
      return;
    }
    if (samplesUrl === null) return;
    const sample = new Audio(`${samplesUrl}${voice}.webm`);
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
        title="Spoken language"
        description="The language the voice speaks when it reads replies and in voice conversations. Applies from the next session."
        control={
          <Select
            value={currentLanguage ?? SERVER_DEFAULT}
            disabled={disabled}
            onValueChange={(value) => value && void chooseLanguage(value)}
          >
            <SelectTrigger aria-label="Spoken language" size="xs" className="min-w-40">
              <SelectValue>
                {currentLanguage === null
                  ? defaultLabel(host && LANGUAGE_LABELS[host.defaultVoiceLanguage])
                  : LANGUAGE_LABELS[currentLanguage]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={SERVER_DEFAULT}>
                {defaultLabel(host && LANGUAGE_LABELS[host.defaultVoiceLanguage])}
              </SelectItem>
              {VOICE_LANGUAGES.map((language) => (
                <SelectItem key={language} value={language}>
                  {LANGUAGE_LABELS[language]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Voice"
        description="Reads replies aloud and talks in voice conversations. A new voice applies at once, also to a conversation already open."
      >
        <RadioGroup
          aria-label="Voice"
          value={current ?? SERVER_DEFAULT}
          disabled={disabled}
          onValueChange={(value) => void choose(String(value))}
        >
          <label className="flex min-h-8 items-center gap-3 text-sm">
            <Radio value={SERVER_DEFAULT} />
            <span className="capitalize">{defaultLabel(host?.defaultVoice)}</span>
          </label>
          {REALTIME_VOICES.map((voice) => (
            <div key={voice} className="flex min-h-8 items-center gap-3">
              <label className="flex flex-1 items-center gap-3 text-sm capitalize">
                <Radio value={voice} />
                {voice}
              </label>
              {samplesUrl !== null ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={playing === voice ? `Stop ${voice}` : `Listen to ${voice}`}
                  onClick={() => preview(voice)}
                >
                  {playing === voice ? <PauseIcon /> : <PlayIcon />}
                </Button>
              ) : null}
            </div>
          ))}
        </RadioGroup>
      </SettingsRow>
    </SettingsSection>
  );
}

/** "Default (cove)" once the host says what its default is; servers built before that say less. */
const defaultLabel = (value: string | undefined) =>
  value === undefined ? "Server default" : `Default (${value})`;

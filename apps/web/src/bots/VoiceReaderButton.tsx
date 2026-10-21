import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  createVoiceReaderDriver,
  type VoiceReaderDriver,
} from "@t3tools/client-runtime/voice-reader";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AudioLinesIcon, SquareIcon, Volume2Icon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { botsEnvironment } from "../state/bots";
import { useServerConfigs } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import {
  acquireVoiceReaderMicrophone,
  openBrowserVoiceReaderPeer,
  releaseVoiceReaderMicrophone,
} from "./voiceReaderPeer";
import { setVoiceReaderEnabled, useVoiceReaderEnabled } from "./voiceReaderStore";

type Props = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function reportError(description: string) {
  toastManager.add({ type: "error", title: "The voice reader failed", description });
}

/** Offers reader controls only on the thread's capable server, on web and desktop. */
export function VoiceReaderButton(props: Props) {
  const configs = useServerConfigs();
  if (configs.get(props.environmentId)?.environment.capabilities.voiceReader !== true) return null;
  return <ThreadVoiceReaderButton key={`${props.environmentId}:${props.threadId}`} {...props} />;
}

function ThreadVoiceReaderButton({ environmentId, threadId }: Props) {
  const enabled = useVoiceReaderEnabled(environmentId, threadId);
  const microphone = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const driver = useRef<VoiceReaderDriver | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const { data, error } = useEnvironmentQuery(
    enabled ? botsEnvironment.voiceReader({ environmentId, input: { threadId } }) : null,
  );
  const latestData = useRef(data);
  useEffect(() => {
    latestData.current = data;
    if (data) driver.current?.update(data);
  }, [data]);
  const off = () => setVoiceReaderEnabled(environmentId, threadId, false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const start = async () => {
      const stream = microphone.current ?? (await acquireVoiceReaderMicrophone());
      if (cancelled) {
        releaseVoiceReaderMicrophone(stream);
        return;
      }
      microphone.current = stream;
      audio.current ??= new Audio();
      audio.current.autoplay = true;
      const output = audio.current;
      driver.current = createVoiceReaderDriver({
        openPeer: async () => openBrowserVoiceReaderPeer({ microphone: stream, audio: output }),
        transport: {
          offer: async (input) => {
            const result = await runAtomCommand(appAtomRegistry, botsEnvironment.voiceReaderOffer, {
              environmentId,
              input,
            });
            if (result._tag === "Failure")
              throw new Error(message(squashAtomCommandFailure(result)));
            return result.value;
          },
          speak: async (input) => {
            const result = await runAtomCommand(appAtomRegistry, botsEnvironment.voiceReaderSpeak, {
              environmentId,
              input,
            });
            if (result._tag === "Failure")
              throw new Error(message(squashAtomCommandFailure(result)));
          },
          stop: async (input) => {
            const result = await runAtomCommand(appAtomRegistry, botsEnvironment.voiceReaderStop, {
              environmentId,
              input,
            });
            if (result._tag === "Failure")
              throw new Error(message(squashAtomCommandFailure(result)));
          },
        },
        onError: reportError,
      });
      if (latestData.current) driver.current.update(latestData.current);
    };
    void start().catch((failure: unknown) => {
      if (cancelled) return;
      reportError(message(failure));
      setVoiceReaderEnabled(environmentId, threadId, false);
    });
    return () => {
      cancelled = true;
      driver.current?.dispose();
      driver.current = null;
      if (microphone.current) releaseVoiceReaderMicrophone(microphone.current);
      microphone.current = null;
      audio.current?.pause();
      if (audio.current) audio.current.srcObject = null;
      audio.current = null;
    };
  }, [enabled, environmentId, threadId]);
  useEffect(() => {
    if (!enabled || !error) return;
    reportError(error);
    setVoiceReaderEnabled(environmentId, threadId, false);
  }, [enabled, error, environmentId, threadId]);

  const enable = async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      const stream = await acquireVoiceReaderMicrophone();
      if (!mounted.current) {
        releaseVoiceReaderMicrophone(stream);
        return;
      }
      microphone.current = stream;
      audio.current = new Audio();
      audio.current.autoplay = true;
      setVoiceReaderEnabled(environmentId, threadId, true);
    } catch (failure) {
      if (mounted.current)
        toastManager.add({
          type: "error",
          title: "Couldn't use the microphone",
          description: message(failure),
        });
    } finally {
      pending.current = false;
    }
  };
  const label = !enabled
    ? "Ler respostas"
    : !data && !error
      ? "Conectando ao Codex…"
      : "Lendo respostas — clique para desligar";
  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant={enabled ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={label}
              aria-pressed={enabled}
              onClick={() => {
                if (enabled) off();
                else void enable();
              }}
            />
          }
        >
          {enabled && !data && !error ? (
            <Spinner />
          ) : enabled && data?.current ? (
            <AudioLinesIcon />
          ) : (
            <Volume2Icon />
          )}
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      {enabled && data?.current ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Parar a fala"
          onClick={() => driver.current?.stopCurrent()}
        >
          <SquareIcon />
        </Button>
      ) : null}
      {enabled && data && data.queued > 0 ? <span className="text-xs">+{data.queued}</span> : null}
    </div>
  );
}

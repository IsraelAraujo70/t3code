import type { EnvironmentId } from "@t3tools/contracts";
import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useStableCallback } from "../hooks/useStableCallback";
import { useDictationEnvironmentId } from "../state/bots";
import { pickRecordingType, transcribeRecording, type RecordingType } from "./dictation";

type Phase = "idle" | "starting" | "recording" | "transcribing";

/** Mobile dictation stops at the same length. */
const RECORDING_LIMIT_SECONDS = 5 * 60;

interface Session {
  readonly draftKey: string;
  readonly type: RecordingType;
  readonly abort: AbortController;
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  readonly chunks: Blob[];
  cancelled: boolean;
  limitTimer: ReturnType<typeof setTimeout> | null;
}

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}

function releaseMicrophone(session: Session): void {
  if (session.limitTimer !== null) clearTimeout(session.limitTimer);
  session.limitTimer = null;
  for (const track of session.stream?.getTracks() ?? []) track.stop();
  session.stream = null;
}

/**
 * Records a dictation, has a server transcribe and clean it up, and hands the text to
 * `onTranscript`. Renders nothing unless a connected server advertises `dictation`. Switching
 * drafts while recording or transcribing drops the dictation, so text never lands in another
 * draft.
 */
export function DictationButton(props: {
  readonly environmentId: EnvironmentId;
  readonly draftKey: string;
  readonly disabled?: boolean;
  readonly onTranscript: (text: string) => void;
}) {
  const dictationEnvironmentId = useDictationEnvironmentId(props.environmentId);
  const [phase, setPhase] = useState<Phase>("idle");
  const [recordingStartedAt, setRecordingStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const sessionRef = useRef<Session | null>(null);

  const cancel = useStableCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    session.cancelled = true;
    session.abort.abort();
    if (session.recorder && session.recorder.state !== "inactive") session.recorder.stop();
    releaseMicrophone(session);
    setPhase("idle");
  });

  useEffect(() => cancel, [cancel]);
  useEffect(() => {
    if (sessionRef.current && sessionRef.current.draftKey !== props.draftKey) cancel();
  }, [cancel, props.draftKey]);

  useEffect(() => {
    if (phase !== "recording") return;
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [phase]);
  const elapsedSeconds = Math.max(0, Math.floor((now - recordingStartedAt) / 1_000));

  const finish = useStableCallback(async (session: Session) => {
    releaseMicrophone(session);
    if (session.cancelled || sessionRef.current !== session || dictationEnvironmentId === null) {
      return;
    }
    setPhase("transcribing");
    try {
      const text = await transcribeRecording({
        environmentId: dictationEnvironmentId,
        recording: new Blob(session.chunks, { type: session.type.mimeType }),
        type: session.type,
        signal: session.abort.signal,
      });
      // Switching drafts cancels the session (see the effect above), so this text is still theirs.
      if (session.cancelled) return;
      if (text.trim().length === 0) {
        toastManager.add({ type: "info", title: "No speech was detected." });
        return;
      }
      props.onTranscript(text.trim());
    } catch (error) {
      if (session.cancelled) return;
      toastManager.add({
        type: "error",
        title: "Couldn't transcribe the dictation",
        description: errorMessage(error),
      });
    } finally {
      if (sessionRef.current === session) {
        sessionRef.current = null;
        setPhase("idle");
      }
    }
  });

  const start = useStableCallback(async () => {
    if (sessionRef.current) return;
    const type = pickRecordingType((mimeType) => MediaRecorder.isTypeSupported(mimeType));
    if (!type) {
      toastManager.add({ type: "error", title: "This browser can't record dictation." });
      return;
    }
    const session: Session = {
      draftKey: props.draftKey,
      type,
      abort: new AbortController(),
      stream: null,
      recorder: null,
      chunks: [],
      cancelled: false,
      limitTimer: null,
    };
    sessionRef.current = session;
    setPhase("starting");
    try {
      session.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (sessionRef.current === session) {
        sessionRef.current = null;
        setPhase("idle");
      }
      toastManager.add({
        type: "error",
        title: "Microphone access is required for dictation",
        description: errorMessage(error),
      });
      return;
    }
    if (session.cancelled) {
      releaseMicrophone(session);
      return;
    }
    const recorder = new MediaRecorder(session.stream, { mimeType: type.mimeType });
    session.recorder = recorder;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) session.chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => void finish(session), { once: true });
    recorder.start();
    session.limitTimer = setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, RECORDING_LIMIT_SECONDS * 1_000);
    const startedAt = Date.now();
    setRecordingStartedAt(startedAt);
    setNow(startedAt);
    setPhase("recording");
  });

  const stop = useStableCallback(() => {
    const recorder = sessionRef.current?.recorder;
    if (recorder?.state === "recording") recorder.stop();
  });

  if (dictationEnvironmentId === null || typeof MediaRecorder === "undefined") return null;

  if (phase === "recording") {
    return (
      <>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onPointerDown={(event) => event.preventDefault()}
                onClick={cancel}
                aria-label="Discard dictation"
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup>Discard dictation</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="destructive-outline"
                size="xs"
                onPointerDown={(event) => event.preventDefault()}
                onClick={stop}
                aria-label="Stop and transcribe"
              />
            }
          >
            <SquareIcon />
            <span className="tabular-nums">{formatElapsed(elapsedSeconds)}</span>
          </TooltipTrigger>
          <TooltipPopup>Stop and transcribe</TooltipPopup>
        </Tooltip>
      </>
    );
  }

  if (phase === "transcribing") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onPointerDown={(event) => event.preventDefault()}
              onClick={cancel}
              aria-label="Cancel transcription"
            />
          }
        >
          <Spinner />
        </TooltipTrigger>
        <TooltipPopup>Transcribing… Click to cancel</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={props.disabled || phase === "starting"}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void start()}
            aria-label="Dictate"
          />
        }
      >
        <MicIcon />
      </TooltipTrigger>
      <TooltipPopup>Dictate</TooltipPopup>
    </Tooltip>
  );
}

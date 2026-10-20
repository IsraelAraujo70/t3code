import type { ComputerStreamInfo, EnvironmentId } from "@t3tools/contracts";
import { MonitorIcon, PauseIcon, PlayIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { useBotsEnvironmentId } from "../state/bots";
import { useEnvironment } from "../state/environments";
import { createComputerStreamClient } from "./computerStream";

type ComputerView =
  | { readonly phase: "connecting" }
  | { readonly phase: "live"; readonly info: ComputerStreamInfo }
  | { readonly phase: "error"; readonly message: string };

const CONNECTING: ComputerView = { phase: "connecting" };

const subscribeToPageVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const isPageVisible = () => document.visibilityState === "visible";

/**
 * The right panel's Computer tab: the bots host's whole screen, live. It streams only while
 * `visible`, the page is visible, and the viewer has not paused it.
 */
export function ComputerPanel({ visible }: { readonly visible: boolean }) {
  const environmentId = useBotsEnvironmentId();
  const environment = useEnvironment(environmentId);
  if (environmentId === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MonitorIcon />
          </EmptyMedia>
          <EmptyTitle>Bots host not connected</EmptyTitle>
          <EmptyDescription>Bots live on another machine that is not connected.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ComputerScreen
      key={environmentId}
      environmentId={environmentId}
      hostLabel={environment?.label ?? "Bots host"}
      visible={visible}
    />
  );
}

function ComputerScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly hostLabel: string;
  readonly visible: boolean;
}) {
  const { environmentId } = props;
  const [paused, setPaused] = useState(false);
  const pageVisible = useSyncExternalStore(subscribeToPageVisibility, isPageVisible);
  const streaming = props.visible && pageVisible && !paused;
  const [view, setView] = useState<ComputerView>(CONNECTING);
  const [hasFrame, setHasFrame] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!streaming) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d") ?? null;
    let stopped = false;
    const client = createComputerStreamClient(environmentId, {
      onInfo: (info) => setView({ phase: "live", info }),
      onError: (message) => setView({ phase: "error", message }),
      // Keep the server's reason on screen while reconnecting after it.
      onDisconnected: () =>
        setView((current) => (current.phase === "error" ? current : CONNECTING)),
      // The server sends one frame per ack, so at most one decode is ever in flight.
      onFrame: (jpeg, ack) => {
        void createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }))
          .then((bitmap) => {
            if (stopped || canvas === null || context === null) {
              bitmap.close();
              return;
            }
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
            }
            context.drawImage(bitmap, 0, 0);
            bitmap.close();
            setHasFrame(true);
          })
          // A frame that fails to decode is skipped; acking it lets the next one repaint.
          .catch(() => undefined)
          .finally(() => {
            if (!stopped) ack();
          });
      },
    });
    return () => {
      stopped = true;
      client.stop();
      setView(CONNECTING);
    };
  }, [environmentId, streaming]);

  const status = paused ? (
    <span className="text-muted-foreground">Paused</span>
  ) : view.phase === "live" ? (
    <>
      <Badge variant="success" size="sm">
        Live
      </Badge>
      <span className="text-muted-foreground tabular-nums">
        {view.info.screenWidth} × {view.info.screenHeight}
      </span>
    </>
  ) : (
    <span className="text-muted-foreground">
      {view.phase === "error" ? "Reconnecting…" : "Connecting…"}
    </span>
  );

  return (
    <div className="flex size-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <MonitorIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium text-foreground">{props.hostLabel}</span>
        {status}
        <div className="ml-auto">
          <Button variant="ghost-muted" size="xs" onClick={() => setPaused((value) => !value)}>
            {paused ? <PlayIcon /> : <PauseIcon />}
            {paused ? "Resume" : "Pause"}
          </Button>
        </div>
      </div>
      {view.phase === "error" && !paused ? (
        <div role="alert" className="border-b bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {view.message}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 bg-background">
        <canvas
          ref={canvasRef}
          aria-label={`Screen of ${props.hostLabel}`}
          className="size-full object-contain"
        />
        {hasFrame ? null : (
          <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
            {paused ? "Paused" : "Waiting for the screen…"}
          </div>
        )}
      </div>
    </div>
  );
}

import type { ComputerStreamInfo, ComputerStreamInput, EnvironmentId } from "@t3tools/contracts";
import { MonitorIcon, MousePointerClickIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Badge } from "../components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Toggle } from "../components/ui/toggle";
import { useStableCallback } from "../hooks/useStableCallback";
import { useBotsEnvironmentId } from "../state/bots";
import { useEnvironment } from "../state/environments";
import { type ComputerStreamClient, createComputerStreamClient } from "./computerStream";
import { useComputerControl } from "./useComputerControl";

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
 * `visible` and the page is visible. A viewer the host lets control it can turn on Control;
 * every connection starts with it off.
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
  const pageVisible = useSyncExternalStore(subscribeToPageVisibility, isPageVisible);
  const streaming = props.visible && pageVisible;
  const [view, setView] = useState<ComputerView>(CONNECTING);
  const [hasFrame, setHasFrame] = useState(false);
  const [canControl, setCanControl] = useState(false);
  const [control, setControl] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<ComputerStreamClient | null>(null);
  const controlling = control && canControl;

  // Stable, so control listeners are not re-attached on every render.
  const send = useStableCallback((input: ComputerStreamInput) => clientRef.current?.send(input));
  const leaveControl = useStableCallback(() => setControl(false));
  useComputerControl({
    active: controlling && hasFrame,
    root: rootRef,
    target: screenRef,
    canvas: canvasRef,
    send,
    onLeave: leaveControl,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the stream socket open while streaming
  useEffect(() => {
    if (!streaming) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d") ?? null;
    let stopped = false;
    const client = createComputerStreamClient(environmentId, {
      onAccess: (allowed) => {
        setCanControl(allowed);
        setControl(false);
      },
      onInfo: (info) => setView({ phase: "live", info }),
      onError: (message) => setView({ phase: "error", message }),
      onDisconnected: () => {
        setCanControl(false);
        setControl(false);
        // Keep the server's reason on screen while reconnecting after it.
        setView((current) => (current.phase === "error" ? current : CONNECTING));
      },
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
    clientRef.current = client;
    return () => {
      stopped = true;
      clientRef.current = null;
      client.stop();
      setView(CONNECTING);
      setCanControl(false);
      setControl(false);
    };
  }, [environmentId, streaming]);

  const status =
    view.phase === "live" ? (
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
    <div ref={rootRef} className="flex size-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <MonitorIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium text-foreground">{props.hostLabel}</span>
        {status}
        {canControl ? (
          <div className="ml-auto">
            <Toggle
              variant="ghost"
              size="compact"
              pressed={controlling}
              onPressedChange={(pressed) => setControl(Boolean(pressed))}
            >
              <MousePointerClickIcon />
              Control
            </Toggle>
          </div>
        ) : null}
      </div>
      {view.phase === "error" ? (
        <div role="alert" className="border-b bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {view.message}
        </div>
      ) : null}
      {/* While in control the screen keeps focus so Escape and Tab reach the host; the outline says so.
          `role="application"` keeps type-to-focus and window refocus off the composer, and
          `data-keybinding-capture` turns off the app's shortcuts, so every key reaches the host. */}
      <div
        ref={screenRef}
        tabIndex={controlling ? 0 : -1}
        role={controlling ? "application" : undefined}
        data-keybinding-capture={controlling ? "" : undefined}
        aria-label={controlling ? `Controlling ${props.hostLabel}` : undefined}
        className={
          controlling
            ? "relative min-h-0 flex-1 touch-none bg-background outline-2 -outline-offset-2 outline-primary"
            : "relative min-h-0 flex-1 bg-background outline-none"
        }
      >
        <canvas
          ref={canvasRef}
          aria-label={`Screen of ${props.hostLabel}`}
          className="size-full object-contain"
        />
        {hasFrame ? null : (
          <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
            Waiting for the screen…
          </div>
        )}
        {/* Without control, typing goes to the composer; say so where the viewer looks. */}
        {hasFrame && !controlling && view.phase === "live" ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
            <span className="rounded-md bg-background/80 px-2 py-0.5 text-xs text-muted-foreground shadow-xs">
              {canControl ? "Turn on Control to type on the host" : "View only"}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

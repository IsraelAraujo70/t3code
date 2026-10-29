// @effect-diagnostics globalTimers:off - The viewer's reconnect and move timers run outside Effect.
import type { ComputerStreamInput, EnvironmentId } from "@t3tools/contracts";
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { Dimensions, PixelRatio, Platform, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { WebView } from "react-native-webview";

import {
  computerFramePoint,
  computerPress,
  computerStreamMaxWidth,
  computerStreamRetryDelayMs,
  createComputerGestureSession,
  createComputerMoveThrottle,
  parseComputerDocumentMessage,
  parseComputerStreamMessage,
  type ComputerSize,
} from "./computer.logic";
import {
  COMPUTER_STOP_SCRIPT,
  computerConnectScript,
  computerSendScript,
  computerStreamDocument,
} from "./computerDocument";
import { readComputerStreamUrl } from "./computerStream";

export interface ComputerStreamRef {
  /** Sends input when the socket is open; dropped otherwise. */
  readonly send: (input: ComputerStreamInput) => void;
}

// Finger travel per wheel notch for two-finger scrolling.
const WHEEL_NOTCH_PX = 32;
// About 30 drag moves a second.
const MOVE_INTERVAL_MS = 33;
const LONG_PRESS_MS = 500;
const monotonicNow = () => performance.now();

/**
 * The bots host's screen, live. Owns the socket's lifecycle: each (re)connect asks for fresh
 * credentials, with a capped backoff after closes. With `control`, gestures become input: tap
 * clicks, long-press right-clicks, one-finger drag drags, two-finger pan scrolls.
 */
export function ComputerStreamView({
  ref,
  environmentId,
  background,
  control,
  onLive,
  onError,
  onAccess,
}: {
  readonly ref?: Ref<ComputerStreamRef>;
  readonly environmentId: EnvironmentId;
  readonly background: string;
  readonly control: boolean;
  /** True from the first frame of a connection until it closes. */
  readonly onLive: (live: boolean) => void;
  readonly onError: (message: string) => void;
  /** The server's answer on each connection; false again whenever the connection drops. */
  readonly onAccess: (canControl: boolean) => void;
}) {
  const webView = useRef<WebView<object>>(null);
  const [attempt, setAttempt] = useState(0);
  const active = useRef(true);
  const failures = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef<ComputerSize>({ width: 0, height: 0 });
  const layout = useRef<ComputerSize>({ width: 0, height: 0 });
  const maxWidth = useMemo(
    () => computerStreamMaxWidth(Dimensions.get("screen").width, PixelRatio.get()),
    [],
  );
  const source = useMemo(
    () => ({
      html: computerStreamDocument(background),
      baseUrl: Platform.OS === "android" ? "https://localhost/" : "file:///",
    }),
    [background],
  );

  // Stable, so gesture handlers built once per `control` keep sending to the current page.
  const send = useMemo(
    () => (input: ComputerStreamInput) =>
      webView.current?.injectJavaScript(computerSendScript(JSON.stringify(input))),
    [],
  );
  useImperativeHandle(ref, () => ({ send }), [send]);

  const connect = async () => {
    retryTimer.current = null;
    const url = await readComputerStreamUrl(environmentId, maxWidth);
    if (!active.current) return;
    if (url === null) {
      scheduleRetry();
      return;
    }
    webView.current?.injectJavaScript(computerConnectScript(url));
  };
  const scheduleRetry = () => {
    if (!active.current || retryTimer.current !== null) return;
    retryTimer.current = setTimeout(
      () => void connect(),
      computerStreamRetryDelayMs(failures.current++),
    );
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the viewer page's socket lifecycle, stopping its script and retry timer on unmount.
  useLayoutEffect(() => {
    active.current = true;
    const view = webView.current;
    return () => {
      active.current = false;
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
      retryTimer.current = null;
      view?.injectJavaScript(COMPUTER_STOP_SCRIPT);
    };
  }, []);

  const restartViewer = () => {
    if (!active.current) return;
    if (retryTimer.current !== null) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    onLive(false);
    onAccess(false);
    setAttempt((current) => current + 1);
  };

  const gesture = useComputerGestures({ control, frame, layout, send });

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: background }}>
      <WebView<object>
        key={attempt}
        ref={webView}
        source={source}
        originWhitelist={["*"]}
        scrollEnabled={false}
        bounces={false}
        mixedContentMode="always"
        contentInsetAdjustmentBehavior="never"
        setSupportMultipleWindows={false}
        style={{ flex: 1, backgroundColor: background }}
        onContentProcessDidTerminate={restartViewer}
        onRenderProcessGone={restartViewer}
        onShouldStartLoadWithRequest={(request) =>
          request.url === "about:blank" || request.url === source.baseUrl
        }
        onMessage={(event) => {
          if (!active.current) return;
          const message = parseComputerDocumentMessage(event.nativeEvent.data);
          if (message === null) return;
          switch (message.type) {
            case "ready":
              void connect();
              return;
            case "frame":
              onLive(true);
              return;
            case "closed":
              onLive(false);
              onAccess(false);
              scheduleRetry();
              return;
            case "failed":
              onError("The screen viewer stopped. Close and reopen it.");
              return;
            case "server": {
              const server = parseComputerStreamMessage(message.text);
              if (server?.type === "info") {
                failures.current = 0;
                frame.current = { width: server.width, height: server.height };
              } else if (server?.type === "access") {
                onAccess(server.canControl);
              } else if (server?.type === "error") {
                onError(server.message);
              }
            }
          }
        }}
      />
      <GestureDetector gesture={gesture}>
        <View
          className="absolute inset-0"
          collapsable={false}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            layout.current = { width, height };
          }}
        />
      </GestureDetector>
    </GestureHandlerRootView>
  );
}

function useComputerGestures({
  control,
  frame,
  layout,
  send,
}: {
  readonly control: boolean;
  readonly frame: { readonly current: ComputerSize };
  readonly layout: { readonly current: ComputerSize };
  readonly send: (input: ComputerStreamInput) => void;
}) {
  const throttle = useMemo(
    () =>
      createComputerMoveThrottle({
        intervalMs: MOVE_INTERVAL_MS,
        now: monotonicNow,
        schedule: (run, delayMs) => {
          const timer = setTimeout(run, delayMs);
          return () => clearTimeout(timer);
        },
        send: (point) => send({ type: "pointer", action: "move", button: "left", ...point }),
      }),
    [send],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancels a held drag move's timer on unmount.
  useEffect(() => () => throttle.cancel(), [throttle]);

  // A held button must outlive any memo cache drop, so the session is created once.
  const [session] = useState(() =>
    createComputerGestureSession({ send, throttle, wheelNotchPx: WHEEL_NOTCH_PX }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Releases the host's held mouse button when control turns off mid-drag.
  useEffect(() => {
    if (!control) session.release();
  }, [control, session]);

  return useMemo(() => {
    const pointAt = (x: number, y: number) =>
      computerFramePoint(layout.current, frame.current, { x, y });
    const press = (x: number, y: number, button: "left" | "right") => {
      const point = pointAt(x, y);
      if (point) for (const input of computerPress(point, button)) send(input);
    };

    // oxlint-disable-next-line react/capitalized-calls -- Gesture.Tap is a gesture factory, not a component.
    const tap = Gesture.Tap()
      .runOnJS(true)
      .enabled(control)
      .maxDuration(LONG_PRESS_MS - 100)
      .onEnd((event, success) => {
        if (success) press(event.x, event.y, "left");
      });
    // oxlint-disable-next-line react/capitalized-calls -- Gesture.LongPress is a gesture factory, not a component.
    const longPress = Gesture.LongPress()
      .runOnJS(true)
      .enabled(control)
      .minDuration(LONG_PRESS_MS)
      .onStart((event) => press(event.x, event.y, "right"));
    // oxlint-disable-next-line react/capitalized-calls -- Gesture.Pan is a gesture factory, not a component.
    const dragPan = Gesture.Pan()
      .runOnJS(true)
      .enabled(control)
      .minPointers(1)
      .maxPointers(1)
      .minDistance(8)
      .onStart((event) => {
        session.dragStart(
          pointAt(event.x - event.translationX, event.y - event.translationY),
          pointAt(event.x, event.y),
        );
      })
      .onUpdate((event) => session.dragMove(pointAt(event.x, event.y)))
      .onFinalize(() => session.dragEnd());
    // oxlint-disable-next-line react/capitalized-calls -- Gesture.Pan is a gesture factory, not a component.
    const scrollPan = Gesture.Pan()
      .runOnJS(true)
      .enabled(control)
      .minPointers(2)
      .onStart((event) => {
        session.scrollStart(pointAt(event.x, event.y), event.translationX, event.translationY);
      })
      .onUpdate((event) => session.scrollMove(event.translationX, event.translationY))
      .onFinalize(() => session.scrollEnd());

    // oxlint-disable-next-line react/capitalized-calls -- Gesture.Race is a gesture factory, not a component.
    return Gesture.Race(scrollPan, dragPan, Gesture.Race(longPress, tap));
  }, [control, frame, layout, send, session]);
}

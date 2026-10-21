// @effect-diagnostics nodeBuiltinImport:off - grim writes binary JPEG to stdout; execFile buffers it in one piece.
/**
 * Captures the bots host's whole screen (every output) as JPEG with `grim`, for the Computer view.
 * One serial loop serves every viewer, runs only while someone watches, and reads the screen
 * geometry from `hyprctl monitors -j`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ComputerStreamInfo } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

/** About 8 frames per second. */
export const FRAME_INTERVAL_MS = 125;
/** How long `hyprctl monitors -j` stays trusted. */
export const GEOMETRY_TTL_MS = 3000;
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_JPEG_BYTES = 64 * 1024 * 1024;

export class ScreenCaptureError extends Schema.TaggedError<ScreenCaptureError>()(
  "ScreenCaptureError",
  { message: Schema.String },
) {}

/** The external commands, injectable so tests need no compositor. */
export interface ScreenCommands {
  /** Stdout of `hyprctl monitors -j`. */
  readonly monitors: Effect.Effect<string, ScreenCaptureError>;
  /** Runs `grim` with these arguments and returns its stdout. */
  readonly grim: (args: ReadonlyArray<string>) => Effect.Effect<Uint8Array, ScreenCaptureError>;
}

export interface ScreenViewerOptions {
  readonly maxWidth: number;
  readonly quality: number;
}

/** One captured frame, shared by every viewer of that tick. */
export interface ScreenFrame {
  readonly info: ComputerStreamInfo;
  readonly jpeg: Uint8Array;
}

export interface ScreenViewer {
  /**
   * The newest frame this viewer has not taken. Frames captured while the viewer was busy are
   * replaced, never queued. Fails once capture fails; the viewer should then leave.
   */
  readonly next: Effect.Effect<ScreenFrame, ScreenCaptureError>;
}

export class ScreenCapture extends Context.Service<
  ScreenCapture,
  {
    /** Watches the screen until the scope closes. */
    readonly attach: (
      options: ScreenViewerOptions,
    ) => Effect.Effect<ScreenViewer, never, Scope.Scope>;
    /** The captured bounding box, from the same short-lived cache the capture loop reads. */
    readonly geometry: Effect.Effect<ScreenGeometry, ScreenCaptureError>;
  }
>()("t3/bots/computer/ScreenCapture") {}

/** Bounding box of every enabled output, in compositor (logical) pixels. */
export interface ScreenGeometry {
  /** Top-left corner of the box in the compositor's global layout. */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** Largest output scale: capturing beyond it only upscales. */
  readonly maxScale: number;
}

const HyprMonitors = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      x: Schema.Number,
      y: Schema.Number,
      width: Schema.Number,
      height: Schema.Number,
      scale: Schema.Number,
      transform: Schema.optional(Schema.Number),
      disabled: Schema.optional(Schema.Boolean),
    }),
  ),
);
const decodeMonitors = Schema.decodeUnknownEffect(HyprMonitors);

/** Parses `hyprctl monitors -j` into the bounding box grim captures without `-o`. */
export const parseGeometry = (json: string) =>
  decodeMonitors(json).pipe(
    Effect.mapError(
      () =>
        new ScreenCaptureError({ message: "hyprctl returned monitors this server can't read." }),
    ),
    Effect.flatMap((monitors) => {
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      let maxScale = 1;
      for (const monitor of monitors) {
        if (monitor.disabled === true || monitor.scale <= 0) continue;
        // Odd transforms rotate the output by 90 degrees.
        const rotated = (monitor.transform ?? 0) % 2 === 1;
        const width = (rotated ? monitor.height : monitor.width) / monitor.scale;
        const height = (rotated ? monitor.width : monitor.height) / monitor.scale;
        left = Math.min(left, monitor.x);
        top = Math.min(top, monitor.y);
        right = Math.max(right, monitor.x + width);
        bottom = Math.max(bottom, monitor.y + height);
        maxScale = Math.max(maxScale, monitor.scale);
      }
      if (!Number.isFinite(left) || right <= left || bottom <= top) {
        return Effect.fail(
          new ScreenCaptureError({ message: "The desktop has no active monitor." }),
        );
      }
      return Effect.succeed<ScreenGeometry>({
        left,
        top,
        width: Math.round(right - left),
        height: Math.round(bottom - top),
        maxScale,
      });
    }),
  );

/** The grim scale that keeps a frame at most `maxWidth` wide, rounded so the argument stays short. */
export const captureScale = (geometry: ScreenGeometry, maxWidth: number) =>
  Math.floor(Math.min(geometry.maxScale, maxWidth / geometry.width) * 10_000) / 10_000;

const DESKTOP_VARIABLES = [
  "PATH",
  "HOME",
  "LANG",
  "XDG_RUNTIME_DIR",
  "WAYLAND_DISPLAY",
  "HYPRLAND_INSTANCE_SIGNATURE",
  // ydotool finds its daemon here when it is not at $XDG_RUNTIME_DIR/.ydotool_socket.
  "YDOTOOL_SOCKET",
] as const;

const newestEntry = (root: string, matches: (name: string) => boolean, directories: boolean) => {
  try {
    return NodeFS.readdirSync(root, { withFileTypes: true })
      .filter((entry) => matches(entry.name) && entry.isDirectory() === directories)
      .map((entry) => ({
        name: entry.name,
        mtime: NodeFS.statSync(NodePath.join(root, entry.name)).mtimeMs,
      }))
      .toSorted((a, b) => b.mtime - a.mtime)[0]?.name;
  } catch {
    return undefined;
  }
};

/**
 * Just what grim and hyprctl need to reach the desktop session, so no server credential leaks
 * into them. Fills the session variables in when the server started outside the session.
 */
export const desktopEnv = (source: NodeJS.ProcessEnv = process.env) => {
  const env: Record<string, string> = {};
  for (const name of DESKTOP_VARIABLES) {
    const value = source[name];
    if (value) env[name] = value;
  }
  env.XDG_RUNTIME_DIR ??= `/run/user/${process.getuid?.() ?? 1000}`;
  env.WAYLAND_DISPLAY ??=
    newestEntry(env.XDG_RUNTIME_DIR, (name) => /^wayland-\d+$/.test(name), false) ?? "wayland-1";
  const signature = newestEntry(NodePath.join(env.XDG_RUNTIME_DIR, "hypr"), () => true, true);
  if (env.HYPRLAND_INSTANCE_SIGNATURE === undefined && signature !== undefined) {
    env.HYPRLAND_INSTANCE_SIGNATURE = signature;
  }
  return env;
};

/** Runs a desktop command and returns its stdout; also used to replay input. */
export const runDesktopCommand = (
  command: string,
  args: ReadonlyArray<string>,
  env: Record<string, string>,
  timeout = COMMAND_TIMEOUT_MS,
) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<Buffer>((resolve, reject) => {
        NodeChildProcess.execFile(
          command,
          args,
          {
            env,
            signal,
            encoding: "buffer",
            maxBuffer: MAX_JPEG_BYTES,
            timeout,
          },
          (error, stdout, stderr) => {
            if (error === null) return resolve(stdout);
            reject(
              error.code === "ENOENT"
                ? `${command} is not installed. The Computer view needs ${command} on a Hyprland desktop.`
                : `${command} failed: ${stderr.toString().trim() || error.message}`,
            );
          },
        );
      }),
    catch: (cause) => new ScreenCaptureError({ message: String(cause) }),
  });

/** The real grim and hyprctl. The session environment is refreshed with every geometry read. */
export const desktopCommands = (): ScreenCommands => {
  let env = desktopEnv();
  return {
    monitors: Effect.suspend(() => {
      env = desktopEnv();
      return runDesktopCommand("hyprctl", ["monitors", "-j"], env);
    }).pipe(Effect.map((stdout) => stdout.toString())),
    grim: (args) => Effect.suspend(() => runDesktopCommand("grim", args, env)),
  };
};

const sameInfo = (a: ComputerStreamInfo, b: ComputerStreamInfo) =>
  a.width === b.width &&
  a.height === b.height &&
  a.screenWidth === b.screenWidth &&
  a.screenHeight === b.screenHeight;

/** Builds the capture service; the shared loop runs in the calling scope. */
export const make = Effect.fn("ScreenCapture.make")(function* (commands: ScreenCommands) {
  const serviceScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  type Viewer = ScreenViewerOptions & {
    readonly frames: Queue.Queue<ScreenFrame, ScreenCaptureError>;
  };
  const viewers = new Set<Viewer>();
  let loop: Fiber.Fiber<void> | undefined;
  let cached: { geometry: ScreenGeometry; expiresAt: number } | undefined;
  let info: ComputerStreamInfo | undefined;

  const geometry = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (cached !== undefined && now < cached.expiresAt) return cached.geometry;
    const fresh = yield* commands.monitors.pipe(Effect.flatMap(parseGeometry));
    cached = { geometry: fresh, expiresAt: now + GEOMETRY_TTL_MS };
    return fresh;
  });

  const tick = Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const screen = yield* geometry;
    // Viewers share one capture, made for the most demanding of them.
    let maxWidth = 0;
    let quality = 0;
    for (const viewer of viewers) {
      maxWidth = Math.max(maxWidth, viewer.maxWidth);
      quality = Math.max(quality, viewer.quality);
    }
    const scale = captureScale(screen, maxWidth);
    const jpeg = yield* commands.grim([
      "-t",
      "jpeg",
      "-q",
      String(quality),
      "-s",
      String(scale),
      "-",
    ]);
    const next: ComputerStreamInfo = {
      type: "info",
      width: Math.round(screen.width * scale),
      height: Math.round(screen.height * scale),
      screenWidth: screen.width,
      screenHeight: screen.height,
    };
    // Viewers resend info only when this object changes.
    info = info !== undefined && sameInfo(info, next) ? info : next;
    const frame: ScreenFrame = { info, jpeg };
    for (const viewer of viewers) Queue.offerUnsafe(viewer.frames, frame);
    const elapsed = (yield* Clock.currentTimeMillis) - started;
    yield* Effect.sleep(Math.max(0, FRAME_INTERVAL_MS - elapsed));
  });

  const runLoop = Effect.forever(tick).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        // Everyone watching sees the failure; the next viewer starts a fresh loop. Reset first:
        // a failed viewer may resume, and attach again, before this handler returns.
        const failed = [...viewers];
        viewers.clear();
        loop = undefined;
        cached = undefined;
        for (const viewer of failed) Queue.failCauseUnsafe(viewer.frames, Cause.fail(error));
      }),
    ),
  );

  const detach = (viewer: Viewer) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        viewers.delete(viewer);
        if (viewers.size > 0 || loop === undefined) return;
        const stopping = loop;
        loop = undefined;
        yield* Fiber.interrupt(stopping);
      }),
    );

  return ScreenCapture.of({
    attach: (options) =>
      Effect.acquireRelease(
        lock.withPermits(1)(
          Effect.gen(function* () {
            const viewer: Viewer = {
              ...options,
              frames: yield* Queue.sliding<ScreenFrame, ScreenCaptureError>(1),
            };
            viewers.add(viewer);
            loop ??= yield* Effect.forkIn(runLoop, serviceScope);
            return viewer;
          }),
        ),
        detach,
      ).pipe(Effect.map((viewer) => ({ next: Queue.take(viewer.frames) }))),
    geometry,
  });
});

export const layer = Layer.effect(
  ScreenCapture,
  Effect.suspend(() => make(desktopCommands())),
);

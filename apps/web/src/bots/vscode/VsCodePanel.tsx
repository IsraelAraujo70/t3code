import { type EnvironmentId, VSCODE_COLOR_SCHEME_MESSAGE } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { VisualStudioCode } from "../../components/Icons";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import { getRenderedAppearance, useRenderedAppearance } from "../../hooks/useTheme";
import { readVsCodeUrl } from "./vsCodeUrl";

type FrameSource =
  | { readonly key: string; readonly phase: "loading" }
  | { readonly key: string; readonly phase: "ready"; readonly url: string }
  | { readonly key: string; readonly phase: "offline" };

function VsCodeEmpty(props: { readonly title: string; readonly description: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <VisualStudioCode />
        </EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** Tells the frame's color-scheme shim (see the server's colorScheme.ts) which mode T3 shows. */
function postColorScheme(frame: HTMLIFrameElement | null, url: string, scheme: "light" | "dark") {
  frame?.contentWindow?.postMessage(
    { type: VSCODE_COLOR_SCHEME_MESSAGE, scheme },
    new URL(url).origin,
  );
}

/**
 * The right panel's VS Code tab: the thread's environment runs `code serve-web` and serves it
 * under `/vscode`, opened on the thread's worktree (or the project root). Keys typed in the frame
 * stay in its document, so the app's shortcuts never see them. VS Code follows T3's light or dark
 * mode: the URL carries it when the frame opens and a message switches it without a reload.
 */
export function VsCodePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly folder: string | undefined;
}) {
  const { environmentId, folder } = props;
  const key = `${environmentId}:${folder ?? ""}`;
  const [source, setSource] = useState<FrameSource>({ key, phase: "loading" });
  const appearance = useRenderedAppearance();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const frameUrl = source.phase === "ready" ? source.url : undefined;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches a one-time access ticket from the environment for each folder the frame opens
  useEffect(() => {
    if (folder === undefined) return;
    let current = true;
    // The mode at open time; later changes go through postColorScheme, so they never reload VS Code.
    void readVsCodeUrl(environmentId, folder, getRenderedAppearance()).then((url) => {
      if (!current) return;
      setSource(url === null ? { key, phase: "offline" } : { key, phase: "ready", url });
    });
    return () => {
      current = false;
    };
  }, [environmentId, folder, key]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes T3's mode into the cross-document VS Code frame
  useEffect(() => {
    if (frameUrl !== undefined) postColorScheme(frameRef.current, frameUrl, appearance);
  }, [appearance, frameUrl]);

  if (folder === undefined) {
    return <VsCodeEmpty title="No folder to open" description="Open a project to use VS Code." />;
  }
  if (source.key !== key || source.phase === "loading") return null;
  if (source.phase === "offline") {
    return (
      <VsCodeEmpty
        title="Environment not connected"
        description="VS Code runs on the thread's environment, which is not connected."
      />
    );
  }
  return (
    <iframe
      ref={frameRef}
      title="VS Code"
      src={source.url}
      onLoad={(event) => postColorScheme(event.currentTarget, source.url, appearance)}
      className="size-full border-0 bg-background"
      allow="clipboard-read; clipboard-write"
    />
  );
}

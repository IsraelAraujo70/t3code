import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { VisualStudioCode } from "../../components/Icons";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
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

/**
 * The right panel's VS Code tab: the thread's environment runs `code serve-web` and serves it
 * under `/vscode`, opened on the thread's worktree (or the project root). Keys typed in the frame
 * stay in its document, so the app's shortcuts never see them.
 */
export function VsCodePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly folder: string | undefined;
}) {
  const { environmentId, folder } = props;
  const key = `${environmentId}:${folder ?? ""}`;
  const [source, setSource] = useState<FrameSource>({ key, phase: "loading" });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches a one-time access ticket from the environment for each folder the frame opens
  useEffect(() => {
    if (folder === undefined) return;
    let current = true;
    void readVsCodeUrl(environmentId, folder).then((url) => {
      if (!current) return;
      setSource(url === null ? { key, phase: "offline" } : { key, phase: "ready", url });
    });
    return () => {
      current = false;
    };
  }, [environmentId, folder, key]);

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
      title="VS Code"
      src={source.url}
      className="size-full border-0 bg-background"
      allow="clipboard-read; clipboard-write"
    />
  );
}

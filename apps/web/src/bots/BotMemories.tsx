import { useAtomValue } from "@effect/atom-react";
import {
  BOT_LIMITS,
  type BotDirectoryEntry,
  type BotMemory,
  type BotMemorySource,
  type EnvironmentId,
} from "@t3tools/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { botsEnvironment } from "../state/bots";
import { useAtomCommand } from "../state/use-atom-command";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { confirmDestructive, reportCommandResult } from "./botsSettingsShared";

const SOURCE_LABELS: Record<BotMemorySource, string> = {
  user: "you",
  bot: "bot",
  import: "import",
};

/** A bot's memories: each one can be switched off, edited, or deleted, and new ones added. */
export function BotMemories({
  environmentId,
  connected,
  bot,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly bot: BotDirectoryEntry;
}) {
  return (
    <div className="space-y-3">
      {bot.memories.length === 0 ? (
        <p className="text-sm text-muted-foreground">No memories yet.</p>
      ) : (
        <ul className="space-y-3">
          {bot.memories.map((memory) => (
            <li key={memory.id}>
              <MemoryItem environmentId={environmentId} connected={connected} memory={memory} />
            </li>
          ))}
        </ul>
      )}
      <NewMemory environmentId={environmentId} connected={connected} bot={bot} />
    </div>
  );
}

function MemoryItem({
  environmentId,
  connected,
  memory,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly memory: BotMemory;
}) {
  const canUpdate = useAtomValue(botsEnvironment.updateMemory.permissionAtom(environmentId));
  const canDelete = useAtomValue(botsEnvironment.deleteMemory.permissionAtom(environmentId));
  const update = useAtomCommand(botsEnvironment.updateMemory, { label: "bot memory update" });
  const remove = useAtomCommand(botsEnvironment.deleteMemory, { label: "bot memory delete" });
  // Null while unedited, so the text follows the live memory until the user types.
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = text ?? memory.text;
  const trimmed = value.trim();
  const dirty = text !== null && trimmed !== memory.text;

  const run = async (action: "toggle" | "save" | "delete") => {
    if (busy) return;
    if (action === "delete" && !(await confirmDestructive("Delete this memory?"))) return;
    setBusy(true);
    const result =
      action === "toggle"
        ? await update({
            environmentId,
            input: { memoryId: memory.id, enabled: !memory.enabled },
          })
        : action === "save"
          ? await update({ environmentId, input: { memoryId: memory.id, text: trimmed } })
          : await remove({ environmentId, input: { memoryId: memory.id } });
    setBusy(false);
    if (reportCommandResult("Could not update memory", result) && action === "save") {
      setText(null);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Switch
          checked={memory.enabled}
          disabled={busy || !connected || !canUpdate}
          aria-label={memory.enabled ? "Turn off memory" : "Turn on memory"}
          onCheckedChange={() => void run("toggle")}
        />
        <Badge variant="outline" size="sm">
          {SOURCE_LABELS[memory.source]}
        </Badge>
        <div className="ms-auto flex items-center gap-1">
          {dirty ? (
            <>
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => setText(null)}>
                Cancel
              </Button>
              <Button
                size="xs"
                disabled={busy || !connected || !canUpdate || trimmed.length === 0}
                onClick={() => void run("save")}
              >
                Save
              </Button>
            </>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost-destructive"
            disabled={busy || !connected || !canDelete}
            aria-label="Delete memory"
            onClick={() => void run("delete")}
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>
      <Textarea
        size="sm"
        aria-label="Memory text"
        maxLength={BOT_LIMITS.memory}
        disabled={busy || !connected || !canUpdate}
        value={value}
        onChange={(event) => setText(event.target.value)}
      />
    </div>
  );
}

function NewMemory({
  environmentId,
  connected,
  bot,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly bot: BotDirectoryEntry;
}) {
  const canCreate = useAtomValue(botsEnvironment.createMemory.permissionAtom(environmentId));
  const create = useAtomCommand(botsEnvironment.createMemory, { label: "bot memory create" });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = text.trim();
  const disabled = busy || !connected || !canCreate;

  const add = async () => {
    if (disabled || trimmed.length === 0) return;
    setBusy(true);
    const result = await create({ environmentId, input: { botId: bot.id, text: trimmed } });
    setBusy(false);
    if (reportCommandResult("Could not add memory", result)) setText("");
  };

  return (
    <div className="space-y-1.5">
      <Textarea
        size="sm"
        aria-label={`New memory for ${bot.name}`}
        placeholder="Something this bot should remember"
        maxLength={BOT_LIMITS.memory}
        disabled={disabled}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex justify-end">
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || trimmed.length === 0}
          onClick={() => void add()}
        >
          <PlusIcon />
          Add memory
        </Button>
      </div>
    </div>
  );
}

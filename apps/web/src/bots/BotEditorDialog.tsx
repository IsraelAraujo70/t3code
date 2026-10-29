import { useAtomValue } from "@effect/atom-react";
import {
  BOT_LIMITS,
  type BotDirectoryEntry,
  type EnvironmentId,
  type ModelSelection,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { useEnvironmentSettings } from "../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import {
  providerInstanceEntriesFor,
  resolveDefaultProviderModelSelection,
} from "../providerInstances";
import { botsEnvironment } from "../state/bots";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { BotAvatar } from "./BotAvatar";
import { BotsField, commandFailureMessage, reportCommandResult } from "./botsSettingsShared";

interface BotDraft {
  readonly name: string;
  readonly role: string;
  /** Null until the user picks a model; the bot's own or the default model shows meanwhile. */
  readonly model: ModelSelection | null;
  readonly canManageBots: boolean;
  readonly linkedEnvironments: boolean;
}

/**
 * Creates a bot (`bot` null) or edits one. `bot` is the live directory entry, so a bot deleted
 * elsewhere while the dialog is open shows as missing instead of saving into nothing. The linked
 * environments switch saves through its own owner-only command, never through `bots.bot.update`,
 * which bot tools also reach; a guest's bot never gets it.
 */
export function BotEditorDialog({
  environmentId,
  connected,
  bot,
  editing,
  linkedEnvironments,
  guest,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly bot: BotDirectoryEntry | null;
  readonly editing: boolean;
  /** Whether the user lets this bot use linked environments today. */
  readonly linkedEnvironments: boolean;
  readonly guest: boolean;
  readonly onClose: () => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const command = editing ? botsEnvironment.updateBot : botsEnvironment.createBot;
  const canOperate = useAtomValue(command.permissionAtom(environmentId));
  const createBot = useAtomCommand(botsEnvironment.createBot, { label: "bot create" });
  const updateBot = useAtomCommand(botsEnvironment.updateBot, { label: "bot update" });
  const canLink = useAtomValue(botsEnvironment.setLinkedEnvironments.permissionAtom(environmentId));
  const setLinked = useAtomCommand(botsEnvironment.setLinkedEnvironments, {
    label: "bot linked environments",
  });
  const [draft, setDraft] = useState<BotDraft>(() => ({
    name: bot?.name ?? "",
    role: bot?.role ?? "",
    model: null,
    canManageBots: bot?.canManageBots ?? false,
    linkedEnvironments,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submissionPending = useRef(false);
  const botMissing = editing && bot === null;

  const instanceEntries = providerInstanceEntriesFor(providers, settings, null);
  const selection =
    draft.model ??
    bot?.model ??
    resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );

  const submit = async () => {
    if (submissionPending.current || saving || !connected || botMissing) return;
    const name = draft.name.trim();
    if (!name || selection === null) {
      setError("Add a name and a model.");
      return;
    }
    // Lock before React renders, and keep a successful save locked until the dialog closes.
    submissionPending.current = true;
    setSaving(true);
    setError(null);
    const fields = {
      name,
      role: draft.role.trim(),
      model: selection,
      canManageBots: draft.canManageBots,
    };
    const result = bot
      ? await updateBot({ environmentId, input: { botId: bot.id, ...fields } })
      : await createBot({ environmentId, input: fields });
    if (result._tag === "Failure") {
      setSaving(false);
      submissionPending.current = false;
      setError(commandFailureMessage(result));
      return;
    }
    // The bot is saved, so a failed switch is reported apart instead of inviting a second save.
    if (!guest && draft.linkedEnvironments !== linkedEnvironments)
      reportCommandResult(
        "Could not change the bot's linked environments",
        await setLinked({
          environmentId,
          input: { botId: result.value.id, linkedEnvironments: draft.linkedEnvironments },
        }),
      );
    setSaving(false);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit bot" : "New bot"}</DialogTitle>
          <DialogDescription>
            A bot keeps one conversation, its own memories, and a standing role.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="space-y-5">
            {!connected ? (
              <p className="text-sm text-destructive">Reconnect this environment before saving.</p>
            ) : null}
            {botMissing ? (
              <p className="text-sm text-destructive" role="status">
                This bot no longer exists.
              </p>
            ) : null}
            <div className="flex items-end gap-3">
              {bot !== null ? <BotAvatar botId={bot.id} size={36} className="mb-0.5" /> : null}
              <BotsField label="Name" htmlFor="bot-name" className="flex-1">
                <Input
                  id="bot-name"
                  placeholder="e.g. Research buddy"
                  maxLength={BOT_LIMITS.name}
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, name: event.target.value }))
                  }
                />
              </BotsField>
            </div>
            <BotsField
              label="Role"
              hint={`${draft.role.length}/${BOT_LIMITS.role}`}
              htmlFor="bot-role"
            >
              <Textarea
                id="bot-role"
                rows={6}
                maxLength={BOT_LIMITS.role}
                placeholder="Who is this bot and how should it work?"
                value={draft.role}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, role: event.target.value }))
                }
              />
            </BotsField>
            <BotsField label="Model">
              {selection ? (
                <div>
                  <ProviderModelPicker
                    environmentId={environmentId}
                    disabled={saving || !connected}
                    activeInstanceId={selection.instanceId}
                    model={selection.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    isComposerOwned={false}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onInstanceModelChange={(instanceId, model) =>
                      setDraft((current) => ({
                        ...current,
                        // Keep the stored selection, with its options, when the pick is unchanged.
                        model:
                          bot && bot.model.instanceId === instanceId && bot.model.model === model
                            ? bot.model
                            : { instanceId, model },
                      }))
                    }
                  />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No provider is available on this environment.
                </p>
              )}
            </BotsField>
            <div className="flex items-center gap-3">
              <Switch
                id="bot-can-manage-bots"
                checked={draft.canManageBots}
                onCheckedChange={(checked) =>
                  setDraft((current) => ({ ...current, canManageBots: checked }))
                }
              />
              <div className="space-y-0.5">
                <Label htmlFor="bot-can-manage-bots">Can manage bots</Label>
                <p className="text-xs text-muted-foreground">
                  Lets this bot create, edit, and delete your bots from its conversation.
                </p>
              </div>
            </div>
            {guest ? null : (
              <div className="flex items-center gap-3">
                <Switch
                  id="bot-linked-environments"
                  checked={draft.linkedEnvironments}
                  disabled={!canLink}
                  onCheckedChange={(checked) =>
                    setDraft((current) => ({ ...current, linkedEnvironments: checked }))
                  }
                />
                <div className="space-y-0.5">
                  <Label htmlFor="bot-linked-environments">May work on linked environments</Label>
                  <p className="text-xs text-muted-foreground">
                    Lets this bot, and the threads it starts, delegates or messages, work on your
                    other machines (Settings → Environments), with each link's access.
                  </p>
                </div>
              </div>
            )}
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={!canOperate || saving || !connected || botMissing}
            onClick={() => void submit()}
          >
            {editing ? "Save bot" : "Create bot"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

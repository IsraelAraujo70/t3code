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
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
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
import { Textarea } from "../components/ui/textarea";
import { BotAvatar } from "./BotAvatar";
import { BotsField, commandFailureMessage } from "./botsSettingsShared";

interface BotDraft {
  readonly name: string;
  readonly role: string;
  /** Null until the user picks a model; the bot's own or the default model shows meanwhile. */
  readonly model: ModelSelection | null;
}

/**
 * Creates a bot (`bot` null) or edits one. `bot` is the live directory entry, so a bot deleted
 * elsewhere while the dialog is open shows as missing instead of saving into nothing.
 */
export function BotEditorDialog({
  environmentId,
  connected,
  bot,
  editing,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly bot: BotDirectoryEntry | null;
  readonly editing: boolean;
  readonly onClose: () => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const command = editing ? botsEnvironment.updateBot : botsEnvironment.createBot;
  const canOperate = useAtomValue(command.permissionAtom(environmentId));
  const createBot = useAtomCommand(botsEnvironment.createBot, { label: "bot create" });
  const updateBot = useAtomCommand(botsEnvironment.updateBot, { label: "bot update" });
  const [draft, setDraft] = useState<BotDraft>(() => ({
    name: bot?.name ?? "",
    role: bot?.role ?? "",
    model: null,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submissionPending = useRef(false);
  const botMissing = editing && bot === null;

  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
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
    const fields = { name, role: draft.role.trim(), model: selection };
    const result = bot
      ? await updateBot({ environmentId, input: { botId: bot.id, ...fields } })
      : await createBot({ environmentId, input: fields });
    setSaving(false);
    if (result._tag === "Failure") {
      submissionPending.current = false;
      setError(commandFailureMessage(result));
      return;
    }
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

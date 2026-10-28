import { useAtomValue } from "@effect/atom-react";
import type { BotDirectory, BotId, EnvironmentId } from "@t3tools/contracts";

import { searchableSetting } from "../components/settings/settingsSearch";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Checkbox } from "../components/ui/checkbox";
import { botsEnvironment } from "../state/bots";
import { useAtomCommand } from "../state/use-atom-command";
import { BotAvatar } from "./BotAvatar";
import { reportCommandResult } from "./botsSettingsShared";

/**
 * Settings → Bots → Linked environments: which bots may act on the user's other machines. Only
 * this switch grants it; no bot tool can.
 */
export function LinkedEnvironmentsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly directory: BotDirectory;
}) {
  const { environmentId, directory } = props;
  const canEdit = useAtomValue(botsEnvironment.setLinkedEnvironments.permissionAtom(environmentId));
  const setLinked = useAtomCommand(botsEnvironment.setLinkedEnvironments, {
    label: "bot linked environments",
  });
  const toggle = async (botId: BotId, linkedEnvironments: boolean) =>
    reportCommandResult(
      "Could not change the bot's linked environments",
      await setLinked({ environmentId, input: { botId, linkedEnvironments } }),
    );
  if (directory.bots.length === 0) return null;
  return (
    <SettingsSection {...searchableSetting("bots-linked-environments")}>
      <SettingsRow
        title="Linked environments"
        description="Checked bots may work on your other machines through Settings → Connections → Linked environments, with each link's access. So may the threads they start, delegate or message. A guest's bot never can."
      >
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
          {directory.bots.map((bot) => {
            const guest = directory.guestBotIds.includes(bot.id);
            return (
              <li key={bot.id}>
                <label className="flex cursor-pointer items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={!guest && directory.linkedEnvironmentBotIds.includes(bot.id)}
                    disabled={guest || !canEdit || !props.connected}
                    onCheckedChange={(checked) => void toggle(bot.id, checked === true)}
                  />
                  <BotAvatar botId={bot.id} size={16} />
                  {bot.name}
                  {guest ? <span className="text-muted-foreground">(guest, sandboxed)</span> : null}
                </label>
              </li>
            );
          })}
        </ul>
      </SettingsRow>
    </SettingsSection>
  );
}

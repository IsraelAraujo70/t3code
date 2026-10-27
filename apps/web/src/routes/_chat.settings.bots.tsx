import { createFileRoute } from "@tanstack/react-router";

import { BotsSettings } from "../bots/BotsSettings";

function SettingsBotsRoute() {
  return <BotsSettings />;
}

export const Route = createFileRoute("/_chat/settings/bots")({
  component: SettingsBotsRoute,
});

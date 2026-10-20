import type { StaticScreenProps } from "@react-navigation/native";
import { View } from "react-native";

type BotsComputerRouteScreenProps = StaticScreenProps<{
  /** The bots host whose screen is shown. */
  readonly environmentId: string;
}>;

/** Full-screen live view of the bots host's desktop, with optional control. */
export function BotsComputerRouteScreen(_props: BotsComputerRouteScreenProps) {
  return <View className="flex-1 bg-sheet" />;
}

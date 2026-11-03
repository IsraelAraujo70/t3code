import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";

/** A titled section that starts folded, for detail a phone screen rarely needs. */
export function Disclosure(props: {
  readonly title: string;
  readonly detail?: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View className="overflow-hidden rounded-2xl bg-grouped-card">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        className="min-h-12 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
      >
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-t3-medium text-foreground">{props.title}</Text>
          {props.detail ? (
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {props.detail}
            </Text>
          ) : null}
        </View>
        <SymbolView
          name={open ? "chevron.up" : "chevron.down"}
          size={12}
          tintColorClassName="accent-icon-muted"
        />
      </Pressable>
      {open ? <View className="gap-3 px-4 pb-4">{props.children}</View> : null}
    </View>
  );
}

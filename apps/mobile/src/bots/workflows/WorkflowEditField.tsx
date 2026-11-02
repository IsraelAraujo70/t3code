import { View, TextInput } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";

/** A labeled phone field for workflow values, with native multiline editing. */
export function WorkflowEditField({
  label,
  value,
  onChange,
  multiline = false,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  maxLength?: number;
}) {
  return (
    <View className="gap-1">
      <Text textRole="footnote">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        maxLength={maxLength}
        autoCapitalize="none"
        autoCorrect={false}
        className="rounded-xl border border-border bg-input p-3 text-foreground"
      />
    </View>
  );
}

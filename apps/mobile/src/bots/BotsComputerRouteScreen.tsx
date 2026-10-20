import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { EnvironmentId, type ComputerStreamInput } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Keyboard,
  Platform,
  ScrollView,
  TextInput,
  View,
  type TextInputInstance,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText } from "../components/AppText";
import { ControlPill } from "../components/ControlPill";
import { ScreenHeader } from "../components/ScreenHeader";
import { ThemedSwitch } from "../components/ThemedSwitch";
import { cn } from "../lib/cn";
import { NativeHeaderToolbar } from "../native/StackHeader";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { COMPUTER_KEY_BAR, computerTypingInputs } from "./computer.logic";
import { ComputerStreamView, type ComputerStreamRef } from "./ComputerStreamView";

const ComputerStack = createNativeStackNavigator<{ Computer: undefined }>();

// The hidden field restarts empty past this length so its diffs stay small.
const MAX_TYPING_BUFFER = 200;

type BotsComputerRouteScreenProps = StaticScreenProps<{
  /** The bots host whose screen is shown. */
  readonly environmentId: string;
}>;

/** Full-screen live view of the bots host's desktop, with optional control. */
export function BotsComputerRouteScreen({ route }: BotsComputerRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = useCallback(() => navigation.goBack(), [navigation]);
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ComputerStack.Navigator
        screenOptions={{
          headerShown: Platform.OS === "ios",
          headerBackVisible: false,
          headerShadowVisible: false,
          headerTransparent: false,
          headerTitleStyle: { fontSize: 17, fontWeight: "600" },
        }}
      >
        <ComputerStack.Screen name="Computer">
          {() => (
            <ComputerScreen
              environmentId={EnvironmentId.make(route.params.environmentId)}
              onClose={onClose}
            />
          )}
        </ComputerStack.Screen>
      </ComputerStack.Navigator>
    </View>
  );
}

function ComputerScreen({
  environmentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { themeVariables } = useAppearancePreferences();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canControl, setCanControl] = useState(false);
  const [control, setControl] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const stream = useRef<ComputerStreamRef>(null);
  const input = useRef<TextInputInstance>(null);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state !== "background"),
    );
    return () => subscription.remove();
  }, []);
  // Capture runs on the host only while a viewer is attached, so a hidden screen detaches.
  const attached = focused && foreground;

  const onLive = useCallback((next: boolean) => {
    setLive(next);
    if (next) setError(null);
  }, []);
  const changeControl = useCallback((next: boolean) => {
    setControl(next);
    if (next) return;
    input.current?.blur();
    setTyped("");
  }, []);
  // Control starts off on every connection, and leaves when the server takes it away.
  const onAccess = useCallback(
    (next: boolean) => {
      setCanControl(next);
      changeControl(false);
    },
    [changeControl],
  );
  // Android's back gesture hides the keyboard without blurring the field.
  useEffect(() => {
    const subscription = Keyboard.addListener("keyboardDidHide", () => input.current?.blur());
    return () => subscription.remove();
  }, []);

  const send = (inputs: ReadonlyArray<ComputerStreamInput>) => {
    for (const message of inputs) stream.current?.send(message);
  };
  const status = live ? "Live" : (error ?? "Connecting…");

  return (
    <View className="flex-1 bg-sheet" style={{ paddingBottom: insets.bottom }}>
      <ScreenHeader
        title="Computer"
        subtitle={status}
        sidebar={false}
        onBack={onClose}
        options={{ headerBackVisible: false }}
        actions={
          control
            ? [
                {
                  accessibilityLabel: typing ? "Hide keyboard" : "Show keyboard",
                  icon: { ios: "keyboard", android: typing ? "keyboard_hide" : "keyboard" },
                  selected: typing,
                  onPress: () => {
                    if (typing) Keyboard.dismiss();
                    else input.current?.focus();
                  },
                },
              ]
            : []
        }
      />
      {Platform.OS === "ios" ? (
        <NativeHeaderToolbar placement="left">
          <NativeHeaderToolbar.Button
            icon="xmark"
            accessibilityLabel="Close computer"
            onPress={onClose}
            separateBackground
          />
        </NativeHeaderToolbar>
      ) : null}
      {canControl ? (
        <View className="flex-row items-center justify-between gap-3 px-4 pb-2">
          <AppText className="text-sm text-foreground-muted">
            {control ? "Your touches and typing go to the computer" : "Control"}
          </AppText>
          <ThemedSwitch
            accessibilityLabel="Control the computer"
            value={control}
            onValueChange={changeControl}
          />
        </View>
      ) : null}
      <KeyboardAvoidingView behavior="padding" className="flex-1">
        {/* Outlined while control is on, so it is clear input reaches the computer. */}
        <View className={cn("flex-1 border-2", control ? "border-primary" : "border-transparent")}>
          {attached ? (
            <ComputerStreamView
              ref={stream}
              environmentId={environmentId}
              background={themeVariables["--color-sheet-solid"]}
              control={control}
              onLive={onLive}
              onError={setError}
              onAccess={onAccess}
            />
          ) : null}
        </View>
        {control ? (
          <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2 px-3 py-2"
          >
            {COMPUTER_KEY_BAR.map((key) => (
              <ControlPill
                key={key.label}
                variant="pill"
                label={key.label}
                accessibilityLabel={key.accessibilityLabel}
                onPress={() => send([key.input])}
              />
            ))}
          </ScrollView>
        ) : null}
      </KeyboardAvoidingView>
      {/* Off-screen field that brings up the phone keyboard; its edits become input. */}
      <TextInput
        ref={input}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="absolute left-0 top-0 h-px w-px opacity-0"
        value={typed}
        editable={control}
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect={false}
        spellCheck={false}
        submitBehavior="submit"
        onFocus={() => setTyping(true)}
        onBlur={() => setTyping(false)}
        onChangeText={(next) => {
          send(computerTypingInputs(typed, next));
          setTyped(next.length > MAX_TYPING_BUFFER ? "" : next);
        }}
        onKeyPress={(event) => {
          // An empty field reports no change for Backspace, only the key press.
          if (event.nativeEvent.key === "Backspace" && typed === "") {
            send([{ type: "key", key: "Backspace", modifiers: [] }]);
          }
        }}
        onSubmitEditing={() => {
          send([{ type: "key", key: "Enter", modifiers: [] }]);
          setTyped("");
        }}
      />
    </View>
  );
}

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { Sheet } from "../../components/ui/Sheet";

/** Reports a failed command in a dialog; returns whether it succeeded. */
export function reportKanbanResult(
  title: string,
  result: AtomCommandResult<unknown, unknown>,
): boolean {
  if (result._tag === "Success") return true;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(title, error instanceof Error ? error.message : String(error));
  }
  return false;
}

export interface KanbanPickerOption {
  readonly value: string;
  readonly label: string;
  readonly subtitle?: string;
  readonly leading?: ReactNode;
}

/**
 * A list of choices in a sheet. Single choice (`multi` false) reports the pick and leaves closing
 * to the caller; multiple choice toggles in place.
 */
export function KanbanPickerSheet(props: {
  readonly title: string;
  readonly options: ReadonlyArray<KanbanPickerOption>;
  readonly selected: ReadonlyArray<string>;
  readonly multi?: boolean;
  readonly emptyText?: string;
  readonly footer?: string;
  readonly header?: ReactNode;
  readonly onPick: (value: string) => void;
  readonly onClose: () => void;
}) {
  return (
    <Sheet title={props.title} onClose={props.onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-3 px-4 pt-3 pb-10"
      >
        {props.header}
        {props.options.length === 0 ? (
          <Text className="py-6 text-center text-sm text-foreground-muted">
            {props.emptyText ?? "Nothing to pick."}
          </Text>
        ) : (
          <View className="overflow-hidden rounded-2xl">
            {props.options.map((option, index) => (
              <SelectionRow
                key={option.value}
                title={option.label}
                subtitle={option.subtitle}
                leading={option.leading}
                role={props.multi ? "checkbox" : "radio"}
                selected={props.selected.includes(option.value)}
                isFirst={index === 0}
                isLast={index === props.options.length - 1}
                onPress={() => props.onPick(option.value)}
              />
            ))}
          </View>
        )}
        {props.footer ? (
          <Text className="px-1 text-xs text-foreground-muted">{props.footer}</Text>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

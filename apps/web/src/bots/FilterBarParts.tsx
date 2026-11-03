/**
 * The Linear-style filter bar's pieces, shared by the kanban and the Workflows page: a chip per
 * clause ("Bot is PM ×"), a checked value in a field's menu, and the search box "/" focuses.
 */
import { SearchIcon, XIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Kbd } from "~/components/ui/kbd";
import { MenuCheckboxItem } from "~/components/ui/menu";
import { isEditableFocused } from "~/lib/editableFocus";

/** One clickable part of a chip; a chip's value menu trigger uses it too. */
export const FILTER_CHIP_PART =
  "flex h-full min-w-0 items-center gap-1 border-input border-s px-1.5 outline-none hover:bg-accent focus-visible:bg-accent";

export function FilterChip(props: {
  readonly icon?: ReactNode;
  readonly field: string;
  readonly op: string;
  /** Absent: the operator is fixed. */
  readonly onFlipOp?: () => void;
  /** Usually a `FILTER_CHIP_PART` button that reopens the value menu. */
  readonly value: ReactNode;
  readonly onRemove: () => void;
}) {
  return (
    <div className="flex h-6 min-w-0 items-center overflow-hidden rounded-md border border-input text-xs">
      <span className="flex items-center gap-1 px-1.5 [&_svg]:size-3 [&_svg]:text-muted-foreground">
        {props.icon}
        {props.field}
      </span>
      {props.onFlipOp === undefined ? (
        <span className="flex h-full items-center border-input border-s px-1.5 text-muted-foreground">
          {props.op}
        </span>
      ) : (
        <button
          type="button"
          className={`${FILTER_CHIP_PART} text-muted-foreground`}
          onClick={props.onFlipOp}
        >
          {props.op}
        </button>
      )}
      {props.value}
      <button
        type="button"
        aria-label={`Remove ${props.field} filter`}
        className={`${FILTER_CHIP_PART} text-muted-foreground hover:text-foreground`}
        onClick={props.onRemove}
      >
        <XIcon aria-hidden className="size-3" />
      </button>
    </div>
  );
}

/** A value in a field's menu: icon, label, how many items have it, checked when filtered on. */
export function FilterOptionItem(props: {
  readonly icon?: ReactNode;
  readonly label: string;
  readonly count?: number | null;
  readonly checked: boolean;
  readonly onToggle: () => void;
  readonly prefix?: string;
}) {
  return (
    <MenuCheckboxItem checked={props.checked} onCheckedChange={props.onToggle}>
      <span className="flex min-w-0 items-center gap-2">
        {props.icon}
        <span className="min-w-0 flex-1 truncate">
          {props.prefix ? <span className="text-muted-foreground">{props.prefix} </span> : null}
          {props.label}
        </span>
        {props.count == null ? null : (
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{props.count}</span>
        )}
      </span>
    </MenuCheckboxItem>
  );
}

export function FilterSearch(props: {
  readonly value: string;
  readonly onChange: (text: string) => void;
  /** "Search issues…" */
  readonly placeholder: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- "/" focuses the search from anywhere on the page (a window key listener).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.defaultPrevented || event.isComposing || isEditableFocused(event.target)) return;
      if (event.target instanceof Element && event.target.closest('[data-slot$="popup"]')) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const label = props.placeholder.replace(/…$/, "");
  return (
    <InputGroup className="w-52">
      <InputGroupAddon>
        <SearchIcon aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        type="search"
        size="sm"
        value={props.value}
        maxLength={200}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            if (props.value) props.onChange("");
            else event.currentTarget.blur();
          }
        }}
        placeholder={props.placeholder}
        aria-label={label}
      />
      {props.value ? null : (
        <InputGroupAddon align="inline-end">
          <Kbd>/</Kbd>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

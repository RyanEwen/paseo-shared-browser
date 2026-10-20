/** Shared checked rows for display settings; choices never imply a browser restart. */
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { View } from "react-native";
import { BrowserMenuHeading, BrowserMenuItem } from "./browser-toolbar-menu";

export interface BrowserMenuChoice<T> {
  value: T;
  label: string;
  detail?: string;
  disabled?: boolean;
}

/** Keep setting labels, selected state, and disabled policy consistent across menu pages. */
export function BrowserMenuChoices<T extends string | number | boolean>(props: {
  theme: PluginHostProps["theme"];
  compact: boolean;
  disabled: boolean;
  title: string;
  /** Optional visible heading when the menu page title does not name this group. */
  heading?: string;
  value: T;
  options: readonly BrowserMenuChoice<T>[];
  onChange(value: T): void;
}) {
  return (
    <View>
      {props.heading ? (
        <BrowserMenuHeading theme={props.theme}>{props.heading}</BrowserMenuHeading>
      ) : null}
      {props.options.map((option) => (
        <BrowserMenuItem
          key={String(option.value)}
          theme={props.theme}
          compact={props.compact}
          label={option.label}
          accessibilityLabel={`${props.title}: ${option.label}`}
          {...(option.detail ? { detail: option.detail } : {})}
          selected={option.value === props.value}
          disabled={props.disabled || option.disabled === true}
          onPress={() => props.onChange(option.value)}
        />
      ))}
    </View>
  );
}

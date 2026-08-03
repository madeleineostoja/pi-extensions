import type { SettingItem } from "@earendil-works/pi-tui";

const MAX_LABEL_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 240;
const CONTROL_PATTERN = /\p{C}/u;

type SandboxSettingBase = {
  id: string;
  label: string;
  description?: string;
};

export type SandboxBooleanSetting = SandboxSettingBase & {
  kind: "boolean";
  value: boolean;
};

export type SandboxChoiceSetting<T extends string = string> =
  SandboxSettingBase & {
    kind: "choice";
    value: T;
    choices: readonly T[];
  };

export type SandboxSetting = SandboxBooleanSetting | SandboxChoiceSetting;

export type SandboxSettingChange = {
  id: string;
  value: boolean | string;
};

function invalidText(value: string, limit: number): boolean {
  return !value.trim() || value.length > limit || CONTROL_PATTERN.test(value);
}

export function sandboxSettingItems(
  settings: readonly SandboxSetting[],
): readonly SettingItem[] {
  const ids = new Set<string>();
  return settings.map((setting) => {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(setting.id) || ids.has(setting.id)) {
      throw new TypeError("Sandbox setting IDs must be unique and valid");
    }
    if (invalidText(setting.label, MAX_LABEL_LENGTH)) {
      throw new TypeError("Sandbox setting label is invalid");
    }
    if (
      setting.description !== undefined &&
      invalidText(setting.description, MAX_DESCRIPTION_LENGTH)
    ) {
      throw new TypeError("Sandbox setting description is invalid");
    }
    ids.add(setting.id);
    const values =
      setting.kind === "boolean" ? ["on", "off"] : [...setting.choices];
    if (!values.length || new Set(values).size !== values.length) {
      throw new TypeError(
        "Sandbox setting choices must be unique and non-empty",
      );
    }
    if (values.some((value) => invalidText(value, MAX_LABEL_LENGTH))) {
      throw new TypeError("Sandbox setting choice is invalid");
    }
    const currentValue =
      setting.kind === "boolean"
        ? setting.value
          ? "on"
          : "off"
        : setting.value;
    if (!values.includes(currentValue)) {
      throw new TypeError("Sandbox setting value is invalid");
    }
    return {
      id: setting.id,
      label: setting.label,
      description: setting.description,
      currentValue,
      values,
    };
  });
}

export function parseSandboxSettingChange(
  settings: readonly SandboxSetting[],
  id: string,
  value: string,
): SandboxSettingChange {
  const setting = settings.find((candidate) => candidate.id === id);
  if (!setting) {
    throw new TypeError("Sandbox setting is unknown");
  }
  if (setting.kind === "boolean") {
    if (value !== "on" && value !== "off") {
      throw new TypeError("Sandbox boolean value is invalid");
    }
    return { id, value: value === "on" };
  }
  if (!setting.choices.includes(value)) {
    throw new TypeError("Sandbox choice value is invalid");
  }
  return { id, value };
}

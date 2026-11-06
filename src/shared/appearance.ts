import { z } from "zod";
import type {
  AppearanceSettings,
  PresetTheme,
  SoftwareSettings,
  ThemeColors,
} from "./types";

export const defaultAppearance = (): AppearanceSettings => ({
  uiFontSize: 14,
  editorFontSize: 17,
  theme: "classic",
  customBase: "classic",
  customColors: null,
});
export const themePresets: {
  id: PresetTheme;
  name: string;
  colors: ThemeColors;
}[] = [
  {
    id: "classic",
    name: "页间经典",
    colors: {
      primary: "#2b5bb8",
      page: "#f1ede4",
      surface: "#fffefb",
      paper: "#fffefb",
      ink: "#1d2433",
      sidebar: "#15213a",
    },
  },
  {
    id: "sage",
    name: "清新青绿",
    colors: {
      primary: "#397464",
      page: "#edf2ec",
      surface: "#fbfdf9",
      paper: "#fbfdf9",
      ink: "#24372e",
      sidebar: "#19342d",
    },
  },
  {
    id: "warm",
    name: "柔和暖棕",
    colors: {
      primary: "#985d3c",
      page: "#f4eae0",
      surface: "#fff9f2",
      paper: "#fff9f2",
      ink: "#3c2c26",
      sidebar: "#392a26",
    },
  },
  {
    id: "night",
    name: "静谧深夜",
    colors: {
      primary: "#8caff5",
      page: "#181d27",
      surface: "#242b38",
      paper: "#202733",
      ink: "#e0e5ee",
      sidebar: "#111723",
    },
  },
];
const presetSchema = z.enum(["classic", "sage", "warm", "night"]);
const hex = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i, "请输入六位十六进制颜色，例如 #2b5bb8。");
export const colorsSchema = z.object({
  primary: hex,
  page: hex,
  surface: hex,
  paper: hex,
  ink: hex,
  sidebar: hex,
});
export const appearanceSchema = z.object({
  uiFontSize: z.number().int().min(12).max(20),
  editorFontSize: z.number().int().min(14).max(32),
  theme: z.enum(["classic", "sage", "warm", "night", "custom"]),
  customBase: presetSchema,
  customColors: colorsSchema.nullable(),
});
export const softwarePatchSchema = z.object({
  closeAction: z.enum(["ask", "minimize", "quit"]).optional(),
  appearance: appearanceSchema.partial().optional(),
});
export function normalizeSoftware(input: unknown): SoftwareSettings {
  const raw = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  const a = (
    raw.appearance && typeof raw.appearance === "object" ? raw.appearance : {}
  ) as Record<string, unknown>;
  const appearance = defaultAppearance();
  for (const key of Object.keys(appearance) as (keyof AppearanceSettings)[]) {
    const result = appearanceSchema.shape[key].safeParse(a[key]);
    if (result.success) Object.assign(appearance, { [key]: result.data });
  }
  return {
    closeAction: z
      .enum(["ask", "minimize", "quit"])
      .catch("ask")
      .parse(raw.closeAction),
    appearance,
  };
}
export function activeColors(a: AppearanceSettings): ThemeColors {
  return a.theme === "custom" && a.customColors
    ? a.customColors
    : themePresets.find(
        (p) => p.id === (a.theme === "custom" ? a.customBase : a.theme),
      )!.colors;
}
export function mix(a: string, b: string, ratio: number) {
  const parts = [1, 3, 5].map((i) =>
    Math.round(
      parseInt(a.slice(i, i + 2), 16) * (1 - ratio) +
        parseInt(b.slice(i, i + 2), 16) * ratio,
    )
      .toString(16)
      .padStart(2, "0"),
  );
  return "#" + parts.join("");
}
export function isDark(color: string) {
  const rgb = [1, 3, 5]
    .map((i) => parseInt(color.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 < 0.179;
}
export function appearanceTokens(a: AppearanceSettings) {
  const c = activeColors(a),
    dark = isDark(c.page),
    sideText = isDark(c.sidebar) ? "#eef1f6" : "#1d2433";
  const contrast = isDark(c.primary) ? "#ffffff" : "#15213a";
  return {
    primary: c.primary,
    "primary-dark": mix(c.primary, c.ink, 0.2),
    "primary-hover": mix(c.primary, c.surface, 0.15),
    "on-primary": contrast,
    "accent-soft": mix(c.surface, c.primary, 0.12),
    "accent-line": mix(c.surface, c.primary, 0.32),
    ink: c.ink,
    "ink-soft": mix(c.ink, c.surface, 0.25),
    muted: mix(c.ink, c.surface, 0.42),
    page: c.page,
    surface: c.surface,
    "surface-muted": mix(c.surface, c.page, 0.65),
    paper: c.paper,
    "paper-ink": isDark(c.paper) ? "#e0e5ee" : "#262c38",
    border: mix(c.surface, c.ink, 0.16),
    "line-strong": mix(c.surface, c.ink, 0.25),
    night: c.sidebar,
    "night-soft": mix(c.sidebar, sideText, 0.06),
    "night-line": mix(c.sidebar, sideText, 0.15),
    "night-text": mix(c.sidebar, sideText, 0.8),
    "sidebar-ink": sideText,
    gold: dark ? "#dec17e" : "#c9a24a",
    "gold-soft": mix(c.surface, "#c9a24a", 0.16),
    "gold-ink": dark ? "#ecd395" : "#77551d",
    danger: dark ? "#f39e98" : "#b4322a",
    "danger-soft": mix(c.surface, "#b4322a", 0.12),
    success: dark ? "#8fd6ab" : "#3f8a5a",
    "success-soft": mix(c.surface, "#3f8a5a", 0.12),
    warn: dark ? "#ecd395" : "#8a5a12",
    "hover-color": mix(c.surface, c.ink, 0.05),
    "ui-font-size": `${a.uiFontSize}px`,
    "story-font-size": `${a.editorFontSize}px`,
  };
}

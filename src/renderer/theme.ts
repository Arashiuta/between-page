import type { GlobalThemeOverrides } from "naive-ui";
import type { AppearanceSettings } from "../shared/types";
import { appearanceTokens } from "../shared/appearance";

export function naiveTheme(a: AppearanceSettings): GlobalThemeOverrides {
  const t = appearanceTokens(a);
  return {
    common: {
      primaryColor: t.primary,
      primaryColorHover: t["primary-hover"],
      primaryColorPressed: t["primary-dark"],
      primaryColorSuppl: t.primary,
      textColorBase: t.ink,
      textColor1: t.ink,
      textColor2: t["ink-soft"],
      textColor3: t.muted,
      placeholderColor: t.muted,
      borderColor: t.border,
      dividerColor: t.border,
      bodyColor: t.page,
      cardColor: t.surface,
      modalColor: t.surface,
      popoverColor: t.surface,
      inputColor: t.surface,
      tableColor: t.surface,
      hoverColor: t["hover-color"],
      baseColor: t.surface,
      actionColor: t["surface-muted"],
      fontSize: "1rem",
      fontSizeMini: ".857143rem",
      fontSizeTiny: ".857143rem",
      fontSizeSmall: ".928571rem",
      fontSizeMedium: "1rem",
      fontSizeLarge: "1.071429rem",
      fontSizeHuge: "1.142857rem",
      borderRadius: "8px",
      fontFamily:
        '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
      errorColor: t.danger,
      successColor: t.success,
      warningColor: t.warn,
    },
    Input: {
      borderFocus: `1px solid ${t.primary}`,
      borderHover: `1px solid ${t["accent-line"]}`,
      boxShadowFocus: `0 0 0 3px ${t["accent-soft"]}`,
    },
    Card: { borderRadius: "14px" },
    Button: {
      fontWeight: "500",
      textColorPrimary: t["on-primary"],
      textColorHoverPrimary: t["on-primary"],
      textColorPressedPrimary: t["on-primary"],
      textColorFocusPrimary: t["on-primary"],
    },
  };
}

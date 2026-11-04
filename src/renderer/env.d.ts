import type { DesktopAPI } from "../shared/types";
declare global {
  interface Window {
    storybook: DesktopAPI;
  }
}
export {};

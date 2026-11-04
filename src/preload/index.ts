import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI, ProgressEvent } from "../shared/types";

const api: DesktopAPI = {
  async invoke<T>(action: string, payload?: unknown): Promise<T> {
    const response = await ipcRenderer.invoke(
      "storybook:invoke",
      action,
      payload,
    );
    if (!response.ok) throw new Error(response.error);
    return response.data as T;
  },
  onProgress(callback: (event: ProgressEvent) => void) {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: ProgressEvent,
    ) => callback(payload);
    ipcRenderer.on("ai:progress", listener);
    return () => ipcRenderer.removeListener("ai:progress", listener);
  },
  onClosing(callback: () => void) {
    ipcRenderer.on("app:closing", callback);
    return () => ipcRenderer.removeListener("app:closing", callback);
  },
};
contextBridge.exposeInMainWorld("storybook", api);

import { BrowserWindow, nativeImage } from "electron";
import { referenceImageLimits } from "../shared/materials";
import { imageMime } from "./storage";

export async function prepareReferenceImage(
  bytes: Buffer,
  maxBytes: number,
): Promise<string> {
  const mime = imageMime(bytes).mime;
  const source = `data:${mime};base64,${bytes.toString("base64")}`;
  const image = nativeImage.createFromBuffer(bytes);
  const { maxEdge } = referenceImageLimits;
  if (!image.isEmpty()) {
    const { width, height } = image.getSize();
    if (bytes.length <= maxBytes && Math.max(width, height) <= maxEdge)
      return source;
  }

  // Chromium decodes WebP too, and composites transparency on white before JPEG encoding.
  const decoder = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const encode = async () => {
      await decoder.loadURL("about:blank");
      return decoder.webContents.executeJavaScript(
        `(async () => {
          const source = ${JSON.stringify(source)};
          const image = new Image();
          image.src = source;
          await image.decode();
          const longest = Math.max(image.naturalWidth, image.naturalHeight);
          if (${bytes.length} <= ${maxBytes} && longest <= ${maxEdge}) return source;
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d");
          if (!context) throw Error("无法处理参考图。");
          let scale = Math.min(1, ${maxEdge} / longest);
          for (let attempt = 0; attempt < 16; attempt++) {
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            context.fillStyle = "#fff";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            const result = canvas.toDataURL("image/jpeg", 0.85);
            const base64 = result.slice(result.indexOf(",") + 1);
            if (base64.length <= ${Math.floor(maxBytes / 3) * 4}) return result;
            scale *= 0.75;
          }
          throw Error("参考图无法压缩到请求大小限制内。");
        })()`,
      ) as Promise<string>;
    };
    return await Promise.race([
      encode(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("参考图处理超时，请重新选择图片。")),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    decoder.destroy();
  }
}

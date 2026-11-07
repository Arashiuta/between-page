import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { decode, destroy, size, empty } = vi.hoisted(() => ({
  decode: vi.fn(),
  destroy: vi.fn(),
  size: vi.fn(),
  empty: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { isPackaged: false },
  nativeImage: {
    createFromBuffer: () => ({ isEmpty: empty, getSize: size }),
  },
  BrowserWindow: class {
    webContents = { executeJavaScript: decode };
    loadURL() {
      return Promise.resolve();
    }
    destroy() {
      destroy();
    }
  },
}));
import { prepareReferenceImage } from "../src/main/reference-images";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=",
  "base64",
);
beforeEach(() => {
  vi.clearAllMocks();
  empty.mockReturnValue(false);
  size.mockReturnValue({ width: 2, height: 1 });
});
afterEach(() => vi.useRealTimers());

describe("创作请求参考图", () => {
  it("小图保留原始格式和字节，不创建解码窗口", async () => {
    expect(await prepareReferenceImage(png, 1_000_000)).toBe(
      "data:image/png;base64," + png.toString("base64"),
    );
    expect(decode).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });
  it.each(["size", "dimensions", "webp"])(
    "%s 超限或需 Chromium 解码时返回处理结果并关闭窗口",
    async (reason) => {
      const original = Buffer.from(png);
      if (reason === "dimensions")
        size.mockReturnValue({ width: 2480, height: 3312 });
      if (reason === "webp") empty.mockReturnValue(true);
      const encoded = "data:image/jpeg;base64,/9j/";
      decode.mockResolvedValue(encoded);
      expect(
        await prepareReferenceImage(png, reason === "size" ? 50 : 1_000_000),
      ).toBe(encoded);
      expect(destroy).toHaveBeenCalledOnce();
      expect(png).toEqual(original);
    },
  );
  it("损坏图片解码失败或超时后关闭窗口，不能回退发送原始大图", async () => {
    empty.mockReturnValue(true);
    decode.mockRejectedValueOnce(new Error("Invalid image"));
    await expect(prepareReferenceImage(png, 1_000_000)).rejects.toThrow(
      "Invalid image",
    );
    expect(destroy).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    decode.mockImplementationOnce(() => new Promise(() => {}));
    const pending = expect(
      prepareReferenceImage(png, 1_000_000),
    ).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(15000);
    await pending;
    expect(destroy).toHaveBeenCalledTimes(2);
  });
});

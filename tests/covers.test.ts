import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, readdir, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { StoryRepository } from "../src/main/database";
import { cropCover, coverCropSchema } from "../src/shared/cover";
import { createDataDirectories } from "../src/main/data-layout";
import { readAsset, removeAsset } from "../src/main/assets";
import type { CoverUpload } from "../src/shared/types";
const { webpDecode, destroyDecoder } = vi.hoisted(() => ({ webpDecode: vi.fn(), destroyDecoder: vi.fn() }));
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "test" },
  safeStorage: {},
  dialog: {},
  nativeImage: {
    createFromBuffer: (bytes: Buffer) => ({
      isEmpty: () => bytes.length < 60 || bytes.subarray(0, 4).toString() === "RIFF",
      getSize: () => ({
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
      }),
    }),
  },
  BrowserWindow: class {
    webContents = { executeJavaScript: webpDecode };
    loadURL() { return Promise.resolve(); }
    destroy() { destroyDecoder(); }
  },
}));
import { createProjectWithCover, saveCover } from "../src/main/covers";
import {
  makeBackup,
  copyDataSnapshot,
  saveSoftwareSettings,
  softwareSettings,
} from "../src/main/storage";
let root: string, dataDir: string, repo: StoryRepository;
const data =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=";
const upload = (): CoverUpload => ({
  name: "封面.png",
  dataUrl: `data:image/png;base64,${data}`,
  crop: cropCover(2, 1),
});
const story = () => ({
  title: "封面故事",
  premise: "",
  mode: "explore" as const,
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "storybook-covers-"));
  dataDir = join(root, "data");
  createDataDirectories(dataDir);
  repo = new StoryRepository(join(dataDir, "database/storybook.sqlite"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (repo.db.open) repo.close();
  if (
    dirname(root) !== tmpdir() ||
    !basename(root).startsWith("storybook-covers-")
  )
    throw new Error("测试目录边界错误");
  await rm(root, { recursive: true, force: true });
});
describe("封面裁切", () => {
  it("横图、竖图和方图始终生成 2:1 取景，平移不出界、缩放限制 1–3 倍", () => {
    for (const [w, h] of [
      [1600, 400],
      [400, 1600],
      [800, 800],
    ])
      for (const zoom of [-1, 1, 2, 3, 100])
        for (const center of [-2, 0.5, 3]) {
          const crop = cropCover(w, h, zoom, center, center);
          expect(coverCropSchema.safeParse(crop).success).toBe(true);
          expect((w * crop.width) / (h * crop.height)).toBeCloseTo(2);
          const actualZoom = cropCover(w, h).width / crop.width;
          expect(actualZoom).toBeGreaterThanOrEqual(1);
          expect(actualZoom).toBeLessThanOrEqual(3);
        }
  });
});
describe("封面保存生命周期", () => {
  it("WebP 由 Chromium 解码，成功与失败均关闭临时解码窗口", async () => {
    const bytes = Buffer.concat([Buffer.from("RIFF0000WEBP"), Buffer.alloc(70)]);
    const webp = { ...upload(), name: "封面.webp", dataUrl: "data:image/webp;base64," + bytes.toString("base64") };
    webpDecode.mockResolvedValueOnce({ width: 800, height: 400 });
    const p = await createProjectWithCover(repo, dataDir, { ...story(), cover: webp });
    expect(repo.getImage(p.cover!.imageId).filename).toMatch(/\.webp$/);
    expect(destroyDecoder).toHaveBeenCalledTimes(1);
    webpDecode.mockRejectedValueOnce(new Error("无法解码"));
    await expect(saveCover(repo, dataDir, p.id, { upload: webp })).rejects.toThrow("WebP");
    expect(repo.getProject(p.id).cover).toEqual(p.cover);
    expect(destroyDecoder).toHaveBeenCalledTimes(2);
    expect(repo.listImages()).toHaveLength(1);
  });
  it("旧故事默认无封面，新建保存原图，重启后取景保持，更换和移除清理旧图", async () => {
    expect(repo.createProject(story()).cover ?? null).toBeNull();
    const created = await createProjectWithCover(repo, dataDir, {
      ...story(),
      cover: upload(),
    });
    const original = repo.getImage(created.cover!.imageId);
    expect(original.filename).toBe(
      `images/covers/stories/${created.id}/${original.id}.png`,
    );
    expect(await readAsset(dataDir, original.filename)).toEqual(
      Buffer.from(data, "base64"),
    );
    const adjusted = cropCover(2, 1, 2, 0.2, 0.6);
    await saveCover(repo, dataDir, created.id, {
      imageId: original.id,
      crop: adjusted,
    });
    repo.close();
    repo = new StoryRepository(join(dataDir, "database/storybook.sqlite"));
    expect(repo.getProject(created.id).cover?.crop).toEqual(adjusted);
    const replaced = await saveCover(repo, dataDir, created.id, {
      upload: upload(),
    });
    expect(replaced.cover?.imageId).not.toBe(original.id);
    await expect(readAsset(dataDir, original.filename)).rejects.toThrow();
    expect(repo.listImages()).toHaveLength(1);
    const removed = await saveCover(repo, dataDir, created.id, null);
    expect(removed.cover).toBeNull();
    expect(repo.listImages()).toHaveLength(0);
  });
  it("只创建无封面故事不写图片；拒绝伪图、错误取景和超大数据", async () => {
    await createProjectWithCover(repo, dataDir, story());
    await expect(
      createProjectWithCover(repo, dataDir, {
        ...story(),
        cover: { ...upload(), dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
      }),
    ).rejects.toThrow("无法读取");
    await expect(
      createProjectWithCover(repo, dataDir, {
        ...story(),
        cover: { ...upload(), crop: { x: 0, y: 0, width: 0.5, height: 1 } },
      }),
    ).rejects.toThrow("取景");
    await expect(
      createProjectWithCover(repo, dataDir, {
        ...story(),
        cover: { ...upload(), dataUrl: "a".repeat(26_666_800) },
      }),
    ).rejects.toThrow();
    expect(repo.listProjects()).toHaveLength(1);
    expect(repo.listImages()).toHaveLength(0);
  });
  it("新建数据库失败时回滚故事、章节和素材，并清理已写文件", async () => {
    vi.spyOn(repo, "addImage").mockImplementation(() => {
      throw new Error("数据库写入失败");
    });
    await expect(
      createProjectWithCover(repo, dataDir, { ...story(), cover: upload() }),
    ).rejects.toThrow("写入失败");
    expect(repo.listProjects()).toEqual([]);
    expect(repo.listImages()).toEqual([]);
    const folders = await readdir(
      join(dataDir, "assets/images/covers/stories"),
    );
    for (const folder of folders)
      expect(
        await readdir(join(dataDir, "assets/images/covers/stories", folder)),
      ).toEqual([]);
  });
  it("替换失败保留旧封面，不能调整其他故事的封面，缺失原图仍可移除", async () => {
    const a = await createProjectWithCover(repo, dataDir, {
      ...story(),
      cover: upload(),
    });
    const b = repo.createProject(story()),
      old = repo.getImage(a.cover!.imageId);
    await expect(
      saveCover(repo, dataDir, b.id, { imageId: old.id, crop: upload().crop }),
    ).rejects.toThrow("不属于");
    const fail = vi.spyOn(repo, "updateProject").mockImplementation(() => {
      throw new Error("保存失败");
    });
    await expect(
      saveCover(repo, dataDir, a.id, { upload: upload() }),
    ).rejects.toThrow("保存失败");
    fail.mockRestore();
    expect(repo.getProject(a.id).cover).toEqual(a.cover);
    expect(repo.listImages()).toHaveLength(1);
    expect(
      await readdir(join(dataDir, "assets/images/covers/stories", a.id)),
    ).toEqual([old.id + ".png"]);
    await removeAsset(dataDir, old.filename);
    expect((await saveCover(repo, dataDir, a.id, null)).cover).toBeNull();
  });
  it("归档删除清理封面记录与文件", async () => {
    const p = await createProjectWithCover(repo, dataDir, {
      ...story(),
      cover: upload(),
    });
    repo.updateProject(p.id, { archived: true });
    const filenames = repo.deleteArchivedProject(p.id);
    expect(filenames).toHaveLength(1);
    for (const filename of filenames) await removeAsset(dataDir, filename);
    expect(repo.listImages()).toEqual([]);
    await expect(readAsset(dataDir, filenames[0])).rejects.toThrow();
  });
  it("ZIP 恢复和迁移均保留封面、裁切、外观与原图", async () => {
    const p = await createProjectWithCover(repo, dataDir, {
      ...story(),
      cover: upload(),
    });
    saveSoftwareSettings(repo, {
      appearance: { theme: "night", uiFontSize: 20 },
    });
    const zip = await makeBackup(repo, dataDir),
      restored = join(root, "restored");
    const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
    execFileSync("pwsh", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(restored)}`,
    ]);
    const moved = join(root, "moved");
    await mkdir(moved);
    await copyDataSnapshot(repo, dataDir, moved);
    for (const target of [restored, moved]) {
      const reopened = new StoryRepository(
        join(target, "database/storybook.sqlite"),
      );
      try {
        expect(reopened.getProject(p.id).cover).toEqual(p.cover);
        expect(softwareSettings(reopened).appearance).toMatchObject({
          theme: "night",
          uiFontSize: 20,
        });
        expect(
          await readFile(
            join(
              target,
              "assets",
              reopened.getImage(p.cover!.imageId).filename,
            ),
          ),
        ).toEqual(Buffer.from(data, "base64"));
      } finally {
        reopened.close();
      }
    }
  });
});

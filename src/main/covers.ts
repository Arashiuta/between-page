import { nativeImage, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import type { CoverCrop, CoverUpload, ImageAsset } from "../shared/types";
import {
  COVER_LIMIT,
  coverUploadSchema,
  coverCropSchema,
  cropCover,
} from "../shared/cover";
import { imageMime } from "./storage";
import { imageFilename, writeAsset, readAsset, removeAsset } from "./assets";
import type { StoryRepository } from "./database";

async function imageSize(bytes: Buffer) {
  const image = nativeImage.createFromBuffer(bytes);
  if (!image.isEmpty()) return image.getSize();
  if (imageMime(bytes).mime !== "image/webp")
    throw new Error("图片无法读取，请选择有效的 PNG、JPEG 或 WebP 图片。");
  // NativeImage only decodes PNG/JPEG; Chromium also supports WebP and alpha.
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
    const decode = async () => {
      await decoder.loadURL("about:blank");
      return decoder.webContents.executeJavaScript(
        `(async () => { const image = new Image(); image.src = ${JSON.stringify("data:image/webp;base64," + bytes.toString("base64"))}; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight }; })()`,
      ) as Promise<{ width: number; height: number }>;
    };
    return await Promise.race([
      decode(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("图片读取超时。")), 15000);
      }),
    ]);
  } catch {
    throw new Error("WebP 图片无法读取，请重新选择有效图片。");
  } finally {
    clearTimeout(timer);
    decoder.destroy();
  }
}
async function validateCrop(bytes: Buffer, input: CoverCrop) {
  const { width, height } = await imageSize(bytes),
    crop = coverCropSchema.parse(input);
  const base = cropCover(width, height),
    zoom = base.width / crop.width;
  if (
    !width ||
    !height ||
    Math.abs((width * crop.width) / (height * crop.height) - 2) > 0.001 ||
    zoom < 0.999999 ||
    zoom > 3.000001
  )
    throw new Error("封面取景无效，请重新调整。");
  return crop;
}
async function prepare(dataDir: string, projectId: string, input: CoverUpload) {
  const value = coverUploadSchema.parse(input);
  const match =
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      value.dataUrl,
    );
  if (!match) throw new Error("请选择 PNG、JPEG 或 WebP 图片。");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > COVER_LIMIT)
    throw new Error("封面请控制在 20 MB 以内。");
  const info = imageMime(bytes),
    crop = await validateCrop(bytes, value.crop),
    id = randomUUID();
  const image: ImageAsset = {
    id,
    projectId,
    chapterId: null,
    revisionId: null,
    kind: "cover",
    name: value.name,
    filename: imageFilename({ id, projectId, kind: "cover" }, info.extension),
    prompt: "",
    referenceIds: [],
    model: "",
    createdAt: new Date().toISOString(),
  };
  await writeAsset(dataDir, image.filename, bytes);
  return { image, cover: { imageId: id, crop } };
}
async function cleanup(dataDir: string, filename: string | null) {
  if (filename)
    await removeAsset(dataDir, filename).catch((error) =>
      console.warn("封面文件未能清理：", filename, error),
    );
}
export async function createProjectWithCover(
  repo: StoryRepository,
  dataDir: string,
  input: Parameters<StoryRepository["createProject"]>[0] & {
    cover?: CoverUpload;
  },
) {
  if (!input.cover) return repo.createProject(input);
  const id = randomUUID(),
    prepared = await prepare(dataDir, id, input.cover);
  try {
    return repo.db.transaction(() => {
      repo.createProject(input, id);
      repo.addImage(prepared.image);
      return repo.updateProject(id, { cover: prepared.cover });
    })();
  } catch (error) {
    await cleanup(dataDir, prepared.image.filename);
    throw error;
  }
}
const changing = new Set<string>();
export async function saveCover(
  repo: StoryRepository,
  dataDir: string,
  projectId: string,
  input: { upload: CoverUpload } | { imageId: string; crop: CoverCrop } | null,
) {
  if (changing.has(projectId)) throw new Error("封面正在保存，请稍后重试。");
  changing.add(projectId);
  let prepared: Awaited<ReturnType<typeof prepare>> | undefined;
  try {
    const old = repo.getProject(projectId).cover;
    let cover = null;
    if (input && "upload" in input) {
      prepared = await prepare(dataDir, projectId, input.upload);
      cover = prepared.cover;
    } else if (input) {
      const image = repo.getImage(input.imageId);
      if (
        image.kind !== "cover" ||
        image.projectId !== projectId ||
        old?.imageId !== image.id
      )
        throw new Error("这张封面不属于当前故事。");
      cover = {
        imageId: image.id,
        crop: await validateCrop(
          await readAsset(dataDir, image.filename),
          input.crop,
        ),
      };
    }
    const result = repo.db.transaction(() => {
      if (prepared) repo.addImage(prepared.image);
      const project = repo.updateProject(projectId, { cover });
      const obsolete =
        old && old.imageId !== cover?.imageId
          ? repo.removeCoverImage(old.imageId)
          : null;
      return { project, obsolete };
    })();
    prepared = undefined; // The new file now belongs to the committed project.
    await cleanup(dataDir, result.obsolete);
    return result.project;
  } catch (error) {
    if (prepared) await cleanup(dataDir, prepared.image.filename);
    throw error;
  } finally {
    changing.delete(projectId);
  }
}

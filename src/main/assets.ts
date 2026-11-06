import {
  lstat,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { join, dirname, extname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ImageAsset } from "../shared/types";
import type { StoryRepository } from "./database";

const pendingWrites = new Set<string>();

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function safeParts(filename: string): string[] {
  const parts = filename.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\\<>:"|?*\x00-\x1f]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new Error("素材路径无效，必须是 assets 内的相对路径。");
  return parts;
}

// All filesystem access goes through here, including legacy flat filenames.
// Refuse links/junctions so a moved or damaged asset tree cannot escape data/.
export async function assetPath(
  dataDir: string,
  filename: string,
): Promise<string> {
  const parts = ["assets", ...safeParts(filename)];
  let path = dataDir;
  for (const part of parts) {
    path = join(path, part);
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error("素材路径不能包含符号链接或目录联接。");
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return path;
}

export function imageFilename(
  image: Pick<ImageAsset, "id" | "kind" | "projectId">,
  extension: string,
): string {
  const purposes: Record<ImageAsset["kind"], string> = {
    reference: "references",
    illustration: "illustrations",
  };
  if (
    !/^[a-z0-9_-]+$/i.test(image.id) ||
    (image.projectId !== null && !/^[a-z0-9_-]+$/i.test(image.projectId)) ||
    ![".png", ".jpg", ".jpeg", ".webp"].includes(extension.toLowerCase()) ||
    !Object.hasOwn(purposes, image.kind)
  )
    throw new Error("图片标识、用途或格式无效。");
  const scope = image.projectId ? `stories/${image.projectId}` : "library";
  return `images/${purposes[image.kind]}/${scope}/${image.id}${extension.toLowerCase()}`;
}

export function readAsset(dataDir: string, filename: string): Promise<Buffer> {
  return assetPath(dataDir, filename).then((path) => readFile(path));
}

export async function removeAsset(dataDir: string, filename: string) {
  await rm(await assetPath(dataDir, filename), { force: true });
}

async function writeAsset(dataDir: string, filename: string, bytes: Buffer) {
  const key = resolve(dataDir, "assets", filename);
  if (pendingWrites.has(key)) throw new Error("该素材正在保存，请稍后重试。");
  pendingWrites.add(key);
  try {
    await writeAssetFile(dataDir, filename, bytes);
  } finally {
    pendingWrites.delete(key);
  }
}

async function writeAssetFile(
  dataDir: string,
  filename: string,
  bytes: Buffer,
) {
  const destination = await assetPath(dataDir, filename);
  await mkdir(dirname(destination), { recursive: true });
  await assetPath(dataDir, filename);
  try {
    await lstat(destination);
    throw new Error("目标素材已存在，未覆盖原文件。");
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const temporaryDir = join(dataDir, "runtime", "tmp");
  await mkdir(temporaryDir, { recursive: true });
  const temporary = join(temporaryDir, `asset-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function saveImageAsset(
  repo: StoryRepository,
  dataDir: string,
  image: ImageAsset,
  bytes: Buffer,
): Promise<ImageAsset> {
  const saved = {
    ...image,
    filename: imageFilename(image, extname(image.filename)),
  };
  await writeAsset(dataDir, saved.filename, bytes);
  try {
    return repo.addImage(saved);
  } catch (error) {
    await removeAsset(dataDir, saved.filename);
    throw error;
  }
}

export async function migrateLegacyAssets(
  repo: StoryRepository,
  dataDir: string,
  beforeMigration: () => Promise<unknown>,
): Promise<{ migrated: number; missing: string[] }> {
  const result = { migrated: 0, missing: [] as string[] };
  const images = repo.listImages();
  const remaining = new Map<string, number>();
  for (const image of images)
    remaining.set(image.filename, (remaining.get(image.filename) ?? 0) + 1);
  let prepared = false;
  for (const image of images) {
    if (image.filename.includes("/")) {
      await assetPath(dataDir, image.filename);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readAsset(dataDir, image.filename);
    } catch (error) {
      if (!missing(error)) throw error;
      result.missing.push(image.id);
      continue; // Keep the original record so restoring the missing file works.
    }
    const filename = imageFilename(image, extname(image.filename));
    if (!prepared) {
      await beforeMigration();
      prepared = true;
    }
    try {
      const existing = await readAsset(dataDir, filename);
      if (!existing.equals(bytes))
        throw new Error(`图片迁移存在文件冲突，已保留原文件：${image.id}`);
    } catch (error) {
      if (!missing(error)) throw error;
      await writeAsset(dataDir, filename, bytes);
    }
    // Copy first, then commit the reference. A crash at either point is retryable.
    repo.updateImageFilename(image.id, filename);
    result.migrated++;
    const count = remaining.get(image.filename)! - 1;
    remaining.set(image.filename, count);
    if (!count) await removeAsset(dataDir, image.filename);
  }
  return result;
}

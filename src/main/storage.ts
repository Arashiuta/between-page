import { app, safeStorage, dialog } from "electron";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  renameSync,
  createWriteStream,
} from "node:fs";
import {
  mkdir,
  readdir,
  cp,
  rm,
  writeFile,
  copyFile,
  rename,
  realpath,
  lstat,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { ZipFile } from "yazl";
import { z } from "zod";
import type { StoryRepository } from "./database";
import type {
  Settings,
  ProviderConfig,
  SoftwareSettings,
} from "../shared/types";
import { modelSelection } from "../shared/models";
import { migrateLegacyAssets } from "./assets";
import { normalizeSoftware, softwarePatchSchema } from "../shared/appearance";
import {
  createDataDirectories,
  assertDataLayoutSupported,
  writeDataLayout,
  DATA_LAYOUT_FILE,
  CONTENT_DIRECTORIES,
  TRANSFER_DIRECTORIES,
} from "./data-layout";

export const programDir = app.isPackaged
  ? process.env.PORTABLE_EXECUTABLE_DIR || dirname(process.execPath)
  : process.cwd();
const locationFile = join(programDir, "data-location.json");
export function resolveDataDir(): string {
  if (process.env.STORYBOOK_DATA_DIR)
    return resolve(process.env.STORYBOOK_DATA_DIR);
  if (existsSync(locationFile)) {
    const config = JSON.parse(readFileSync(locationFile, "utf8")) as {
      dataDir?: string;
    };
    if (config.dataDir) return resolve(config.dataDir);
  }
  return join(programDir, "data");
}
export function initializeDirectories(dataDir: string) {
  createDataDirectories(dataDir);
  app.setPath("userData", join(dataDir, "runtime"));
  app.setPath("sessionData", join(dataDir, "runtime", "session"));
  app.setAppLogsPath(join(dataDir, "runtime", "logs"));
}
export async function upgradeDataLayout(
  repo: StoryRepository,
  dataDir: string,
) {
  assertDataLayoutSupported(dataDir);
  const result = await migrateLegacyAssets(repo, dataDir, () =>
    makeBackup(repo, dataDir),
  );
  await writeDataLayout(dataDir);
  return result;
}
export function readKey(repo: StoryRepository, kind: "text" | "image"): string {
  const stored = repo.getSetting<string>(`${kind}.key`, "");
  if (!stored) return "";
  if (repo.getSetting<string>(`${kind}.keyFormat`, "") === "plain")
    return stored;
  try {
    // Only older versions used Windows encryption. Migrate once on this account.
    const key = safeStorage.decryptString(Buffer.from(stored, "base64"));
    saveKey(repo, kind, key);
    return key;
  } catch {
    // Keep the original record if it cannot be decrypted on this computer.
    return "";
  }
}
export function saveKey(
  repo: StoryRepository,
  kind: "text" | "image",
  key: string,
) {
  repo.db.transaction(() => {
    repo.setSetting(`${kind}.key`, key);
    repo.setSetting(`${kind}.keyFormat`, "plain");
  })();
}
export function settings(repo: StoryRepository, dataDir: string): Settings {
  const provider = (kind: "text" | "image"): ProviderConfig => {
    const key = readKey(repo, kind);
    return {
      baseUrl: repo.getSetting(`${kind}.url`, "https://api.openai.com/v1"),
      ...modelSelection(
        repo.getSetting(`${kind}.model`, kind === "image" ? "gpt-image-2" : ""),
        repo.getSetting<string[] | undefined>(
          `${kind}.selectedModels`,
          undefined,
        ),
        repo.getSetting(`${kind}.availableModels`, []),
      ),
      capabilities: repo.getSetting(`${kind}.capabilities`, {}),
      key,
      hasKey: !!key.trim(),
    };
  };
  return {
    text: provider("text"),
    software: softwareSettings(repo),
    image: provider("image"),
    imageSize: repo.getSetting("image.size", "1024x1024"),
    imageQuality: repo.getSetting("image.quality", "auto"),
    dataDir,
    version: app.getVersion(),
  };
}
export function softwareSettings(repo: StoryRepository): SoftwareSettings {
  return normalizeSoftware(repo.getSetting("software", {}));
}
export function saveSoftwareSettings(
  repo: StoryRepository,
  input: unknown,
): SoftwareSettings {
  const patch = softwarePatchSchema.parse(input),
    current = softwareSettings(repo);
  const value = {
    ...current,
    ...patch,
    appearance: { ...current.appearance, ...patch.appearance },
  };
  repo.setSetting("software", value);
  return value;
}
export function saveSettings(
  repo: StoryRepository,
  dataDir: string,
  input: unknown,
): Settings {
  const modelName = z.string().trim().min(1).max(500);
  const provider = z.object({
    // Keep unfinished input locally; validate the URL when making a request.
    baseUrl: z.string().max(2000),
    key: z.string().max(4000),
    model: z.string().trim().max(500),
    selectedModels: z.array(modelName).max(200),
    availableModels: z.array(modelName).max(3200),
    capabilities: z.record(
      z.string(),
      z.object({
        vision: z.boolean(),
        contextTokens: z.number().int().min(4096).max(10000000),
        outputTokens: z.number().int().min(256).max(200000),
      }),
    ),
  });
  const value = z
    .object({
      text: provider,
      image: provider,
      imageSize: z.string().max(500),
      imageQuality: z.enum(["auto", "low", "medium", "high"]),
    })
    .parse(input);
  repo.db.transaction(() => {
    for (const kind of ["text", "image"] as const) {
      const config = value[kind];
      const selection = modelSelection(
        config.model,
        config.selectedModels,
        config.availableModels,
      );
      repo.setSetting(`${kind}.url`, config.baseUrl);
      repo.setSetting(`${kind}.model`, selection.model);
      repo.setSetting(`${kind}.selectedModels`, selection.selectedModels);
      repo.setSetting(`${kind}.availableModels`, selection.availableModels);
      repo.setSetting(`${kind}.capabilities`, config.capabilities);
      saveKey(repo, kind, config.key);
    }
    repo.setSetting("image.size", value.imageSize);
    repo.setSetting("image.quality", value.imageQuality);
  })();
  return settings(repo, dataDir);
}
export function imageMime(bytes: Buffer): { mime: string; extension: string } {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { mime: "image/png", extension: ".png" };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return { mime: "image/jpeg", extension: ".jpg" };
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return { mime: "image/webp", extension: ".webp" };
  throw new Error(
    "暂时支持 PNG、JPEG 和 WebP 图片，服务返回的文件格式无法识别。",
  );
}
export async function makeBackup(
  repo: StoryRepository,
  dataDir: string,
): Promise<string> {
  const id = randomUUID(),
    staging = join(dataDir, "backups", `.staging-${id}`);
  await mkdir(join(staging, "database"), { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = join(
    dataDir,
    "backups",
    `页间备份-${timestamp}-${id.slice(0, 8)}.zip`,
  );
  const partial = destination + ".partial";
  try {
    await repo.backup(join(staging, "database", "storybook.sqlite"));
    await writeFile(
      join(staging, "恢复说明.txt"),
      "完全退出页间（包括系统托盘）后，先保留现有数据目录副本，再将本备份解压到一个新的数据目录。database、assets、settings 与 data-layout.json（若存在）必须来自同一份备份，不要合并不同快照或遗留的 SQLite -wal/-shm 文件。软件会自动识别并整理旧版图片目录。备份不包含 exports、历史备份和 runtime 缓存；如需保留这些文件，请在退出软件后另行复制。API Key 明文保存在数据库中，随完整备份一起保存。\n",
      "utf8",
    );
    if (existsSync(join(dataDir, DATA_LAYOUT_FILE)))
      await copyFile(
        join(dataDir, DATA_LAYOUT_FILE),
        join(staging, DATA_LAYOUT_FILE),
      );
    const files: { path: string; name: string }[] = [];
    async function addFolder(source: string, prefix: string) {
      if ((await lstat(source)).isSymbolicLink())
        throw new Error("备份目录不能包含符号链接或目录联接。");
      for (const entry of await readdir(source, { withFileTypes: true })) {
        const path = join(source, entry.name),
          name = prefix + entry.name;
        if (entry.isSymbolicLink())
          throw new Error("备份目录不能包含符号链接或目录联接。");
        if (entry.isDirectory()) await addFolder(path, name + "/");
        else if (entry.isFile()) files.push({ path, name });
      }
    }
    await addFolder(staging, "");
    for (const name of CONTENT_DIRECTORIES)
      if (existsSync(join(dataDir, name)))
        await addFolder(join(dataDir, name), name + "/");
    const archive = new ZipFile();
    const output = createWriteStream(partial, { flags: "wx" });
    const zipStream = archive.outputStream as Readable;
    archive.on("error", (error) => zipStream.destroy(error));
    const writing = pipeline(zipStream, output);
    try {
      for (const file of files) archive.addFile(file.path, file.name);
      archive.end();
      await writing;
    } catch (error) {
      zipStream.destroy();
      output.destroy();
      await writing.catch(() => undefined);
      throw error;
    }
    await rename(partial, destination);
    return destination;
  } finally {
    await rm(partial, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}
function nested(a: string, b: string) {
  const part = relative(a, b);
  return part === "" || (!part.startsWith("..") && !isAbsolute(part));
}

// Copy durable content and user outputs; rebuild runtime at the destination.
export async function copyDataSnapshot(
  repo: StoryRepository,
  dataDir: string,
  target: string,
) {
  const sourcePath = await realpath(dataDir),
    targetPath = await realpath(target);
  if (nested(sourcePath, targetPath) || nested(targetPath, sourcePath))
    throw new Error("新目录不能是当前数据目录、其上级或其内部目录。");
  if ((await readdir(targetPath)).length)
    throw new Error("请选择空文件夹。原数据将保留，不会覆盖其他文件。");
  const staging = join(targetPath, `.migration-${randomUUID()}`);
  try {
    await mkdir(join(staging, "database"), { recursive: true });
    await repo.backup(join(staging, "database", "storybook.sqlite"));
    for (const name of TRANSFER_DIRECTORIES) {
      if (!existsSync(join(sourcePath, name))) continue;
      await cp(join(sourcePath, name), join(staging, name), {
        recursive: true,
        // Never follow or reproduce a link outside the portable data tree.
        filter: async (source) => {
          if ((await lstat(source)).isSymbolicLink())
            throw new Error("迁移目录不能包含符号链接或目录联接。");
          return true;
        },
      });
    }
    if (existsSync(join(sourcePath, DATA_LAYOUT_FILE)))
      await copyFile(
        join(sourcePath, DATA_LAYOUT_FILE),
        join(staging, DATA_LAYOUT_FILE),
      );
    for (const name of await readdir(staging))
      await rename(join(staging, name), join(targetPath, name));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
export async function migrateData(
  repo: StoryRepository,
  dataDir: string,
): Promise<boolean> {
  const result = await dialog.showOpenDialog({
    title: "选择一个空文件夹作为新的数据目录",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled) return false;
  const target = resolve(result.filePaths[0]);
  await copyDataSnapshot(repo, dataDir, target);
  writeFileSync(
    locationFile + ".tmp",
    JSON.stringify({ dataDir: target }, null, 2),
    "utf8",
  );
  renameSync(locationFile + ".tmp", locationFile);
  return true;
}

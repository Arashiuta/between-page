import { app, safeStorage, dialog } from "electron";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
  renameSync,
  createWriteStream,
} from "node:fs";
import { mkdir, readdir, cp, rm, writeFile } from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { ZipFile } from "yazl";
import type { StoryRepository } from "./database";
import type { Settings, ProviderConfig } from "../shared/types";
import { modelSelection } from "../shared/models";

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
  for (const name of [
    "database",
    "assets",
    "settings",
    "backups",
    "exports",
    "runtime",
  ])
    mkdirSync(join(dataDir, name), { recursive: true });
  app.setPath("userData", join(dataDir, "runtime"));
  app.setPath("sessionData", join(dataDir, "runtime", "session"));
  app.setAppLogsPath(join(dataDir, "runtime", "logs"));
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
  const provider = (kind: "text" | "image"): ProviderConfig => ({
    baseUrl: repo.getSetting(`${kind}.url`, "https://api.openai.com/v1"),
    ...modelSelection(
      repo.getSetting(`${kind}.model`, kind === "image" ? "gpt-image-2" : ""),
      repo.getSetting<string[] | undefined>(
        `${kind}.selectedModels`,
        undefined,
      ),
      repo.getSetting(`${kind}.availableModels`, []),
    ),
    hasKey: !!readKey(repo, kind),
  });
  return {
    text: provider("text"),
    image: provider("image"),
    imageSize: repo.getSetting("image.size", "1024x1024"),
    imageQuality: repo.getSetting("image.quality", "auto"),
    dataDir,
    version: app.getVersion(),
  };
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
  const destination = join(dataDir, "backups", `页间备份-${timestamp}.zip`);
  try {
    await repo.backup(join(staging, "database", "storybook.sqlite"));
    await writeFile(
      join(staging, "恢复说明.txt"),
      "关闭页间后，将本备份中的 database 和 assets 文件夹复制到软件的 data 目录。覆盖前先备份原目录。API Key 明文保存在数据库中，随完整备份一起保存。\n",
      "utf8",
    );
    const archive = new ZipFile();
    async function addFolder(source: string, prefix: string) {
      for (const entry of await readdir(source, { withFileTypes: true })) {
        const path = join(source, entry.name),
          name = prefix + entry.name;
        if (entry.isDirectory()) await addFolder(path, name + "/");
        else if (entry.isFile()) archive.addFile(path, name);
      }
    }
    await addFolder(staging, "");
    await addFolder(join(dataDir, "assets"), "assets/");
    await new Promise<void>((resolveBackup, reject) => {
      const output = createWriteStream(destination);
      output.on("close", () => resolveBackup());
      output.on("error", reject);
      archive.on("error", reject);
      archive.outputStream.on("error", reject);
      archive.outputStream.pipe(output);
      archive.end();
    });
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
function nested(a: string, b: string) {
  const part = relative(a, b);
  return part === "" || (!part.startsWith("..") && !isAbsolute(part));
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
  if (nested(dataDir, target) || nested(target, dataDir))
    throw new Error("新目录不能是当前数据目录、其上级或其内部目录。");
  if ((await readdir(target)).length)
    throw new Error("请选择空文件夹。原数据将保留，不会覆盖其他文件。");
  await mkdir(join(target, "database"), { recursive: true });
  await repo.backup(join(target, "database", "storybook.sqlite"));
  for (const name of ["assets", "settings", "backups", "exports"])
    await cp(join(dataDir, name), join(target, name), { recursive: true });
  writeFileSync(
    locationFile + ".tmp",
    JSON.stringify({ dataDir: target }, null, 2),
    "utf8",
  );
  renameSync(locationFile + ".tmp", locationFile);
  return true;
}

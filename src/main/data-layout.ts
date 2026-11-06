import { mkdirSync, existsSync, readFileSync, lstatSync } from "node:fs";
import { writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const DATA_LAYOUT_VERSION = 2;
export const DATA_LAYOUT_FILE = "data-layout.json";
// Durable content is backed up; derived runtime files are always disposable.
export const CONTENT_DIRECTORIES = ["assets", "settings"] as const;
export const TRANSFER_DIRECTORIES = [
  ...CONTENT_DIRECTORIES,
  "backups",
  "exports",
] as const;

export function createDataDirectories(dataDir: string) {
  for (const directory of [
    "database",
    ...TRANSFER_DIRECTORIES,
    "assets/images/references/library",
    "assets/images/references/stories",
    "assets/images/illustrations/stories",
    "runtime/tmp",
  ]) {
    let path = dataDir;
    for (const part of directory.split("/")) {
      path = join(path, part);
      try {
        if (lstatSync(path).isSymbolicLink())
          throw new Error("数据子目录不能包含符号链接或目录联接。");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      mkdirSync(path, { recursive: true });
    }
  }
}

export function assertDataLayoutSupported(dataDir: string) {
  const file = join(dataDir, DATA_LAYOUT_FILE);
  if (!existsSync(file)) return; // Unmarked data uses the original flat layout.
  let manifest: { formatVersion?: unknown };
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
    if (!manifest || !Number.isInteger(manifest.formatVersion))
      throw new Error();
  } catch {
    throw new Error("数据目录的 data-layout.json 已损坏，请从备份恢复该文件。");
  }
  if (
    (manifest.formatVersion as number) < 1 ||
    (manifest.formatVersion as number) > DATA_LAYOUT_VERSION
  )
    throw new Error(
      "此数据目录使用不支持的存储版本，请使用对应或更新版本的页间打开。",
    );
}

export async function writeDataLayout(dataDir: string) {
  const temporary = join(
    dataDir,
    "runtime",
    "tmp",
    `layout-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(
      temporary,
      JSON.stringify(
        { application: "between-pages", formatVersion: DATA_LAYOUT_VERSION },
        null,
        2,
      ) + "\n",
      { encoding: "utf8", flag: "wx" },
    );
    await rename(temporary, join(dataDir, DATA_LAYOUT_FILE));
  } finally {
    await rm(temporary, { force: true });
  }
}

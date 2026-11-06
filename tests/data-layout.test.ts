import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { StoryRepository } from "../src/main/database";
import {
  assetPath,
  imageFilename,
  migrateLegacyAssets,
  readAsset,
  removeAsset,
  saveImageAsset,
} from "../src/main/assets";
import {
  assertDataLayoutSupported,
  createDataDirectories,
  DATA_LAYOUT_FILE,
} from "../src/main/data-layout";
import type { ImageAsset } from "../src/shared/types";

vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "test" },
  safeStorage: {},
  dialog: {},
}));
import {
  copyDataSnapshot,
  makeBackup,
  upgradeDataLayout,
} from "../src/main/storage";

let root: string, dataDir: string, repo: StoryRepository;
const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 42]);
function image(patch: Partial<ImageAsset> = {}): ImageAsset {
  const id = randomUUID();
  return {
    id,
    projectId: null,
    chapterId: null,
    revisionId: null,
    kind: "reference",
    name: "参考图",
    filename: `${id}.png`,
    prompt: "",
    referenceIds: [],
    model: "",
    createdAt: "2026-11-06",
    ...patch,
  };
}
function unpack(zip: string, destination: string) {
  const quote = (path: string) => "'" + path.replaceAll("'", "''") + "'";
  execFileSync("pwsh", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(destination)}`,
  ]);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "storybook-layout-"));
  dataDir = join(root, "data");
  createDataDirectories(dataDir);
  repo = new StoryRepository(join(dataDir, "database", "storybook.sqlite"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (repo.db.open) repo.close();
  if (
    dirname(root) !== tmpdir() ||
    !basename(root).startsWith("storybook-layout-")
  )
    throw new Error("测试目录边界错误");
  await rm(root, { recursive: true, force: true });
});

describe("分类素材目录", () => {
  it("参考图按资料库/故事隔离，生成插画独立存放，重命名故事不影响读取", async () => {
    const project = repo.createProject({
      title: "旧名称",
      premise: "",
      mode: "explore",
    });
    const library = await saveImageAsset(repo, dataDir, image(), bytes);
    const reference = await saveImageAsset(
      repo,
      dataDir,
      image({ projectId: project.id }),
      bytes,
    );
    const illustration = await saveImageAsset(
      repo,
      dataDir,
      image({ projectId: project.id, kind: "illustration" }),
      bytes,
    );
    expect(library.filename).toBe(
      `images/references/library/${library.id}.png`,
    );
    expect(reference.filename).toBe(
      `images/references/stories/${project.id}/${reference.id}.png`,
    );
    expect(illustration.filename).toBe(
      `images/illustrations/stories/${project.id}/${illustration.id}.png`,
    );
    repo.updateProject(project.id, { title: "包含 / 和非法文件名 : 的新名称" });
    for (const asset of [library, reference, illustration])
      expect(
        await readAsset(dataDir, repo.getImage(asset.id).filename),
      ).toEqual(bytes);
    expect(await readdir(join(dataDir, "runtime", "tmp"))).toEqual([]);
  });

  it("拒绝覆盖已有文件，数据库写入失败时清理新文件", async () => {
    const original = image();
    const saved = await saveImageAsset(repo, dataDir, original, bytes);
    await expect(
      saveImageAsset(repo, dataDir, original, Buffer.from("changed")),
    ).rejects.toThrow("已存在");
    expect(await readAsset(dataDir, saved.filename)).toEqual(bytes);
    const orphan = image({ projectId: randomUUID() });
    await expect(
      saveImageAsset(repo, dataDir, orphan, bytes),
    ).rejects.toThrow();
    await expect(
      readAsset(dataDir, imageFilename(orphan, ".png")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(dataDir, "runtime", "tmp"))).toEqual([]);
  });

  it("并发保存相同 ID 时只有一次成功，保留成功文件", async () => {
    const asset = image();
    const results = await Promise.allSettled([
      saveImageAsset(repo, dataDir, asset, bytes),
      saveImageAsset(repo, dataDir, asset, Buffer.from("other")),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await readAsset(dataDir, repo.getImage(asset.id).filename)).toEqual(
      bytes,
    );
  });

  it("故事删除保留资料库仍在使用的图片，只清理独占文件", async () => {
    const project = repo.createProject({
      title: "删除测试",
      premise: "",
      mode: "explore",
    });
    const shared = await saveImageAsset(
      repo,
      dataDir,
      image({ projectId: project.id }),
      bytes,
    );
    const exclusive = await saveImageAsset(
      repo,
      dataDir,
      image({ projectId: project.id, kind: "illustration" }),
      bytes,
    );
    repo.saveCard({
      projectId: null,
      kind: "character",
      name: "引用的角色",
      description: "",
      constraints: "",
      sections: [],
      documents: [],
      referenceIds: [shared.id],
    });
    repo.updateProject(project.id, { archived: true });
    const filenames = repo.deleteArchivedProject(project.id);
    expect(filenames).toEqual([exclusive.filename]);
    for (const filename of filenames) await removeAsset(dataDir, filename);
    expect(repo.getImage(shared.id).projectId).toBeNull();
    expect(await readAsset(dataDir, shared.filename)).toEqual(bytes);
    await expect(readAsset(dataDir, exclusive.filename)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    "../outside.png",
    "/absolute.png",
    "C:/outside.png",
    "..\\outside.png",
    "images/../../outside.png",
    "images//a.png",
    "images/NUL.png",
    "images/a.png:stream",
  ])("拒绝越界或 Windows 特殊路径：%s", async (filename) => {
    await expect(readAsset(dataDir, filename)).rejects.toThrow("路径无效");
    await expect(removeAsset(dataDir, filename)).rejects.toThrow("路径无效");
  });

  it("读取、删除、备份和迁移均拒绝通过目录联接访问外部文件", async () => {
    const outside = join(root, "outside"),
      target = join(root, "target");
    await mkdir(outside);
    await mkdir(target);
    await writeFile(join(outside, "private.png"), bytes);
    await symlink(
      outside,
      join(dataDir, "assets", "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(readAsset(dataDir, "linked/private.png")).rejects.toThrow(
      "符号链接",
    );
    await expect(removeAsset(dataDir, "linked/private.png")).rejects.toThrow(
      "符号链接",
    );
    await expect(makeBackup(repo, dataDir)).rejects.toThrow("符号链接");
    await expect(copyDataSnapshot(repo, dataDir, target)).rejects.toThrow(
      "符号链接",
    );
    expect(await readFile(join(outside, "private.png"))).toEqual(bytes);
    expect(await readdir(target)).toEqual([]);
    expect(await readdir(join(dataDir, "backups"))).toEqual([]);
  });

  it("目录初始化拒绝素材根目录联接，不在外部位置创建目录", async () => {
    const outside = join(root, "outside-init"),
      linkedData = join(root, "linked-data");
    await mkdir(outside);
    await mkdir(linkedData);
    await symlink(
      outside,
      join(linkedData, "assets"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => createDataDirectories(linkedData)).toThrow("目录联接");
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("旧数据迁移与重试", () => {
  it("迁移前保存可恢复的旧版备份，未知文件保留，重复启动不会重复迁移", async () => {
    const old = repo.addImage(image({ filename: "old.png" }));
    await writeFile(join(dataDir, "assets", old.filename), bytes);
    await writeFile(join(dataDir, "assets", "unknown.dat"), "保留未知素材");
    expect(await upgradeDataLayout(repo, dataDir)).toEqual({
      migrated: 1,
      missing: [],
    });
    expect(await readAsset(dataDir, repo.getImage(old.id).filename)).toEqual(
      bytes,
    );
    await expect(readAsset(dataDir, old.filename)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const archives = await readdir(join(dataDir, "backups"));
    expect(archives).toHaveLength(1);
    const restoredDir = join(root, "old-restored");
    unpack(join(dataDir, "backups", archives[0]), restoredDir);
    const restored = new StoryRepository(
      join(restoredDir, "database", "storybook.sqlite"),
    );
    try {
      expect(restored.getImage(old.id).filename).toBe("old.png");
      expect(await readAsset(restoredDir, "old.png")).toEqual(bytes);
      createDataDirectories(restoredDir);
      expect((await upgradeDataLayout(restored, restoredDir)).migrated).toBe(1);
      expect(
        await readAsset(restoredDir, restored.getImage(old.id).filename),
      ).toEqual(bytes);
    } finally {
      restored.close();
    }
    expect(await upgradeDataLayout(repo, dataDir)).toEqual({
      migrated: 0,
      missing: [],
    });
    expect(await readdir(join(dataDir, "backups"))).toEqual(archives);
    expect(await readAsset(dataDir, "unknown.dat")).toEqual(
      Buffer.from("保留未知素材"),
    );
  });

  it("复制后数据库更新中断，重试校验文件内容并完成迁移", async () => {
    const old = repo.addImage(image({ filename: "interrupted.png" }));
    await writeFile(await assetPath(dataDir, old.filename), bytes);
    const snapshot = vi.fn(async () => {});
    vi.spyOn(repo, "updateImageFilename").mockImplementationOnce(() => {
      throw new Error("模拟中断");
    });
    await expect(migrateLegacyAssets(repo, dataDir, snapshot)).rejects.toThrow(
      "模拟中断",
    );
    expect(repo.getImage(old.id).filename).toBe(old.filename);
    expect(await readAsset(dataDir, old.filename)).toEqual(bytes);
    expect(await readAsset(dataDir, imageFilename(old, ".png"))).toEqual(bytes);
    vi.restoreAllMocks();
    expect((await migrateLegacyAssets(repo, dataDir, snapshot)).migrated).toBe(
      1,
    );
    expect(repo.getImage(old.id).id).toBe(old.id);
  });

  it("备份失败或目标文件冲突时不改动旧记录和原图", async () => {
    const old = repo.addImage(image({ filename: "keep.png" }));
    await writeFile(await assetPath(dataDir, old.filename), bytes);
    await expect(
      migrateLegacyAssets(repo, dataDir, async () => {
        throw new Error("磁盘空间不足");
      }),
    ).rejects.toThrow("磁盘空间不足");
    const destination = await assetPath(dataDir, imageFilename(old, ".png"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, "conflict");
    await expect(
      migrateLegacyAssets(repo, dataDir, async () => {}),
    ).rejects.toThrow("文件冲突");
    expect(repo.getImage(old.id).filename).toBe("keep.png");
    expect(await readAsset(dataDir, old.filename)).toEqual(bytes);
    expect(await readFile(destination, "utf8")).toBe("conflict");
  });

  it("多个记录共用旧文件时都能迁移，缺失的原图补回后可继续整理", async () => {
    const first = repo.addImage(image({ filename: "shared.png" }));
    const second = repo.addImage(
      image({ filename: "shared.png", kind: "illustration" }),
    );
    const absent = repo.addImage(image({ filename: "missing.png" }));
    await writeFile(await assetPath(dataDir, first.filename), bytes);
    const snapshot = vi.fn(async () => {});
    expect(await migrateLegacyAssets(repo, dataDir, snapshot)).toEqual({
      migrated: 2,
      missing: [absent.id],
    });
    expect(snapshot).toHaveBeenCalledTimes(1);
    for (const id of [first.id, second.id])
      expect(await readAsset(dataDir, repo.getImage(id).filename)).toEqual(
        bytes,
      );
    expect(repo.getImage(absent.id).filename).toBe("missing.png");
    await writeFile(await assetPath(dataDir, absent.filename), bytes);
    expect((await migrateLegacyAssets(repo, dataDir, snapshot)).migrated).toBe(
      1,
    );
  });

  it("拒绝损坏的目录版本和未来版本，保留原元数据", async () => {
    const manifest = join(dataDir, DATA_LAYOUT_FILE);
    await writeFile(manifest, '{"formatVersion":999}');
    expect(() => assertDataLayoutSupported(dataDir)).toThrow(
      "不支持的存储版本",
    );
    await expect(upgradeDataLayout(repo, dataDir)).rejects.toThrow("不支持");
    expect(await readFile(manifest, "utf8")).toBe('{"formatVersion":999}');
    await writeFile(manifest, "broken");
    expect(() => assertDataLayoutSupported(dataDir)).toThrow("已损坏");
  });
});

describe("新目录的备份与迁移", () => {
  it("数据库快照失败时不发布备份或迁移结果，原图仍在", async () => {
    const asset = await saveImageAsset(repo, dataDir, image(), bytes);
    const target = join(root, "failed-move");
    await mkdir(target);
    vi.spyOn(repo, "backup").mockRejectedValue(new Error("快照失败"));
    await expect(makeBackup(repo, dataDir)).rejects.toThrow("快照失败");
    await expect(copyDataSnapshot(repo, dataDir, target)).rejects.toThrow(
      "快照失败",
    );
    expect(await readdir(join(dataDir, "backups"))).toEqual([]);
    expect(await readdir(target)).toEqual([]);
    expect(await readAsset(dataDir, asset.filename)).toEqual(bytes);
  });

  it("ZIP 恢复保留嵌套路径、设置和版本，排除运行数据及递归备份", async () => {
    const asset = await saveImageAsset(repo, dataDir, image(), bytes);
    await upgradeDataLayout(repo, dataDir);
    await writeFile(join(dataDir, "settings", "future.json"), "扩展配置");
    await mkdir(join(dataDir, "assets", "documents"));
    await writeFile(
      join(dataDir, "assets", "documents", "future.txt"),
      "未来素材",
    );
    await writeFile(
      join(dataDir, "runtime", "tmp", "unfinished.tmp"),
      "partial",
    );
    await writeFile(join(dataDir, "exports", "export.md"), "导出");
    const zip = await makeBackup(repo, dataDir),
      restoredDir = join(root, "zip-restored");
    unpack(zip, restoredDir);
    const restored = new StoryRepository(
      join(restoredDir, "database", "storybook.sqlite"),
    );
    try {
      expect(
        await readAsset(restoredDir, restored.getImage(asset.id).filename),
      ).toEqual(bytes);
    } finally {
      restored.close();
    }
    expect(
      JSON.parse(await readFile(join(restoredDir, DATA_LAYOUT_FILE), "utf8"))
        .formatVersion,
    ).toBe(2);
    expect(
      await readFile(join(restoredDir, "settings", "future.json"), "utf8"),
    ).toBe("扩展配置");
    expect(await readAsset(restoredDir, "documents/future.txt")).toEqual(
      Buffer.from("未来素材"),
    );
    for (const excluded of ["runtime", "backups", "exports"])
      await expect(readdir(join(restoredDir, excluded))).rejects.toMatchObject({
        code: "ENOENT",
      });
  });

  it("目录迁移保留历史备份/导出且支持更换绝对路径，原数据不受影响", async () => {
    const asset = await saveImageAsset(repo, dataDir, image(), bytes);
    await upgradeDataLayout(repo, dataDir);
    await writeFile(join(dataDir, "backups", "previous.zip"), "previous");
    await writeFile(join(dataDir, "exports", "story.md"), "正文");
    await writeFile(join(dataDir, "runtime", "cache"), "cache");
    const target = join(root, "moved");
    await mkdir(target);
    await copyDataSnapshot(repo, dataDir, target);
    const moved = new StoryRepository(
      join(target, "database", "storybook.sqlite"),
    );
    try {
      expect(
        await readAsset(target, moved.getImage(asset.id).filename),
      ).toEqual(bytes);
    } finally {
      moved.close();
    }
    expect(await readAsset(dataDir, asset.filename)).toEqual(bytes);
    expect(
      await readFile(join(target, "backups", "previous.zip"), "utf8"),
    ).toBe("previous");
    expect(await readFile(join(target, "exports", "story.md"), "utf8")).toBe(
      "正文",
    );
    expect(await readFile(join(target, DATA_LAYOUT_FILE), "utf8")).toBe(
      await readFile(join(dataDir, DATA_LAYOUT_FILE), "utf8"),
    );
    await expect(readdir(join(target, "runtime"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(copyDataSnapshot(repo, dataDir, target)).rejects.toThrow(
      "空文件夹",
    );
    await expect(
      copyDataSnapshot(repo, dataDir, join(dataDir, "exports")),
    ).rejects.toThrow("内部目录");
  });
});

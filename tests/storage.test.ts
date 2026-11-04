import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { StoryRepository } from "../src/main/database";
import { textToDocument, documentToText } from "../src/shared/document";
const { decryptString } = vi.hoisted(() => ({ decryptString: vi.fn() }));
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "test" },
  safeStorage: { decryptString },
  dialog: {},
}));
import { makeBackup, readKey, saveKey, settings } from "../src/main/storage";
const directories: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  for (const dir of directories.splice(0)) {
    if (
      dirname(dir) !== tmpdir() ||
      !basename(dir).startsWith("storybook-test-")
    )
      throw new Error("测试目录边界错误");
    await rm(dir, { recursive: true, force: true });
  }
});
describe("文件保存与恢复", () => {
  it("新 Key 明文保存并持久化，不调用系统加密服务", () => {
    const repo = new StoryRepository(":memory:");
    try {
      saveKey(repo, "text", "qa-plain-key");
      expect(repo.getSetting("text.key", "")).toBe("qa-plain-key");
      expect(readKey(repo, "text")).toBe("qa-plain-key");
      expect(settings(repo, "test").text.hasKey).toBe(true);
      expect(decryptString).not.toHaveBeenCalled();
      saveKey(repo, "text", "");
      expect(readKey(repo, "text")).toBe("");
    } finally {
      repo.close();
    }
  });
  it("旧版 Key 解密后迁移为明文，之后不再依赖原 Windows 账户", () => {
    const repo = new StoryRepository(":memory:");
    try {
      repo.setSetting(
        "image.key",
        Buffer.from("old-encrypted").toString("base64"),
      );
      decryptString.mockReturnValueOnce("qa-migrated-key");
      expect(readKey(repo, "image")).toBe("qa-migrated-key");
      expect(repo.getSetting("image.key", "")).toBe("qa-migrated-key");
      expect(repo.getSetting("image.keyFormat", "")).toBe("plain");
      expect(readKey(repo, "image")).toBe("qa-migrated-key");
      expect(decryptString).toHaveBeenCalledTimes(1);
    } finally {
      repo.close();
    }
  });
  it("旧 Key 无法解密时保留原记录，重新填写可覆盖", () => {
    const repo = new StoryRepository(":memory:");
    try {
      repo.setSetting("text.key", "unavailable-old-key");
      decryptString.mockImplementation(() => {
        throw new Error("other account");
      });
      expect(readKey(repo, "text")).toBe("");
      expect(repo.getSetting("text.key", "")).toBe("unavailable-old-key");
      saveKey(repo, "text", "qa-replacement");
      expect(readKey(repo, "text")).toBe("qa-replacement");
    } finally {
      repo.close();
    }
  });
  it("旧版模型配置保留为已选模型，明确清空后不会重新默认勾选", () => {
    const repo = new StoryRepository(":memory:");
    try {
      repo.setSetting("text.model", "custom-writer");
      expect(settings(repo, "test").text.selectedModels).toEqual([
        "custom-writer",
      ]);
      expect(settings(repo, "test").image.selectedModels).toEqual([
        "gpt-image-2",
      ]);
      repo.setSetting("text.selectedModels", []);
      expect(settings(repo, "test").text.model).toBe("");
      expect(settings(repo, "test").text.selectedModels).toEqual([]);
    } finally {
      repo.close();
    }
  });
  it("在线备份可恢复 SQLite 数据及图片，备份中不包含运行缓存", async () => {
    const dir = await mkdtemp(join(tmpdir(), "storybook-test-"));
    directories.push(dir);
    for (const sub of ["database", "assets", "backups", "runtime"])
      await mkdir(join(dir, sub), { recursive: true });
    const repo = new StoryRepository(join(dir, "database", "storybook.sqlite"));
    try {
      const project = repo.createProject({
        title: "备份后仍在",
        premise: "",
        mode: "explore",
      });
      saveKey(repo, "text", "qa-backup-key");
      const chapter = repo.getDetail(project.id).chapters[0];
      repo.updateChapter(chapter.id, {
        document: textToDocument("写进备份的正文"),
      });
      repo.adoptChapter(chapter.id);
      await writeFile(
        join(dir, "assets", "reference.png"),
        Buffer.from([1, 2, 3, 4]),
      );
      const zip = await makeBackup(repo, dir);
      expect((await readFile(zip)).subarray(0, 2).toString()).toBe("PK");
      const escaped = zip.replaceAll("'", "''"),
        destination = join(dir, "restored").replaceAll("'", "''");
      execFileSync("pwsh", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${escaped}' -DestinationPath '${destination}'`,
      ]);
      const restored = new StoryRepository(
        join(dir, "restored", "database", "storybook.sqlite"),
      );
      try {
        expect(restored.getDetail(project.id).chapters[0].content).toBe(
          "写进备份的正文",
        );
        expect(restored.getDetail(project.id).chapters[0].dirty).toBe(false);
        expect(readKey(restored, "text")).toBe("qa-backup-key");
      } finally {
        restored.close();
      }
      expect(
        await readFile(join(dir, "restored", "assets", "reference.png")),
      ).toEqual(Buffer.from([1, 2, 3, 4]));
      await expect(
        readFile(join(dir, "restored", "runtime", "cache")),
      ).rejects.toThrow();
    } finally {
      repo.close();
    }
  });
  it("模型常见的空行段落转换后不会产生多余空段落", () => {
    const doc = textToDocument("第一段\n\n第二段\r\n\r\n第三段");
    expect(doc.content).toHaveLength(3);
    expect(documentToText(doc)).toBe("第一段\n第二段\n第三段");
  });
});

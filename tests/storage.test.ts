import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { StoryRepository } from "../src/main/database";
import { textToDocument, documentToText } from "../src/shared/document";
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "test" },
  safeStorage: {},
  dialog: {},
}));
import { makeBackup } from "../src/main/storage";
const directories: string[] = [];
afterEach(async () => {
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

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import {
  chat,
  consumeSSE,
  endpoint,
  generateImage,
} from "../src/main/provider";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});
async function server(handler: RequestListener) {
  const instance = createServer(handler);
  servers.push(instance);
  await new Promise<void>((resolve) =>
    instance.listen(0, "127.0.0.1", resolve),
  );
  const address = instance.address() as { port: number };
  return `http://127.0.0.1:${address.port}/v1`;
}
describe("兼容接口", () => {
  it("规范化基础地址与完整端点，保留代理查询参数", () => {
    expect(endpoint("https://example.test/v1/", "chat/completions")).toBe(
      "https://example.test/v1/chat/completions",
    );
    expect(
      endpoint(
        "https://example.test/v1/images/generations?route=test",
        "images/edits",
      ),
    ).toBe("https://example.test/v1/images/edits?route=test");
    expect(() => endpoint("file:///secret", "images/generations")).toThrow();
  });
  it("跨网络分片正确读取中文、CRLF、多行 SSE 与结束标记", async () => {
    const encoder = new TextEncoder(),
      input =
        'data: {"choices":[{"delta":{"content":"风铃"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"响了。"}}]}\n\ndata: [DONE]\n\n';
    const bytes = encoder.encode(input),
      deltas: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 5)
          controller.enqueue(bytes.slice(i, i + 5));
        controller.close();
      },
    });
    expect(await consumeSSE(stream, (delta) => deltas.push(delta))).toBe(
      "风铃响了。",
    );
    expect(deltas.join("")).toBe("风铃响了。");
  });
  it("通过真实本地 HTTP 请求兼容不流式的代理", async () => {
    let requestBody: any;
    const url = await server(async (req, res) => {
      requestBody = await new Promise((resolve) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => resolve(JSON.parse(body)));
      });
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }),
      );
    });
    expect(
      await chat(
        { baseUrl: url, model: "local-test", key: "test-only" },
        [{ role: "user", content: "测试" }],
        () => {},
      ),
    ).toBe("连接成功");
    expect(requestBody.stream).toBe(true);
    expect(requestBody.model).toBe("local-test");
  });
  it("生图支持 base64 返回，图片输入使用 multipart 编辑接口", async () => {
    let path = "",
      contentType = "",
      body = "";
    const url = await server(async (req, res) => {
      path = req.url!;
      contentType = req.headers["content-type"] || "";
      for await (const chunk of req) body += chunk.toString();
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ b64_json: Buffer.from("image-test").toString("base64") }],
        }),
      );
    });
    const result = await generateImage(
      { baseUrl: url, model: "gpt-image-2", key: "test-only" },
      "保持 OC 外貌",
      "1024x1024",
      "auto",
      [{ data: new Uint8Array([1, 2]), name: "oc.png", mime: "image/png" }],
    );
    expect(path).toBe("/v1/images/edits");
    expect(contentType).toContain("multipart/form-data");
    expect(body).toContain("image[]");
    expect(body).toContain("gpt-image-2");
    expect(result.bytes.toString()).toBe("image-test");
  });
  it("服务失败时显示有用的错误信息，不当作成功正文", async () => {
    const url = await server((_req, res) => {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: "invalid key" } }));
    });
    await expect(
      chat({ baseUrl: url, model: "test", key: "test-only" }, [], () => {}),
    ).rejects.toThrow("401");
  });
  it("取消信号中断请求", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      chat(
        { baseUrl: "http://127.0.0.1:9/v1", model: "test", key: "test-only" },
        [],
        () => {},
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});

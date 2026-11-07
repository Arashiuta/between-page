import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import {
  chat,
  consumeSSE,
  endpoint,
  generateImage,
  listModels,
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
  it.each(["missing", "length", "content_filter"])(
    "流式输出 %s 时不当作完成",
    async (reason) => {
      const text =
        "data: " +
        JSON.stringify({
          choices: [
            {
              delta: { content: "部分正文" },
              ...(reason === "missing" ? {} : { finish_reason: reason }),
            },
          ],
        }) +
        "\n\n";
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(text));
          c.close();
        },
      });
      await expect(consumeSSE(stream, () => {})).rejects.toThrow(/未完成|中断/);
    },
  );
  it("多模态图片实际出现在 HTTP 载荷，输出遵守配置上限", async () => {
    let actual: any;
    const url = await server(async (req, res) => {
      let text = "";
      for await (const c of req) text += c;
      actual = JSON.parse(text);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "完成" }, finish_reason: "stop" }],
        }),
      );
    });
    await chat(
      { baseUrl: url, model: "mock-vision", key: "test-only" },
      [
        {
          role: "user",
          content: [
            { type: "text", text: "人物参考" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,aW1hZ2U=" },
            },
          ],
        },
      ],
      () => {},
      undefined,
      8192,
    );
    expect(actual.messages[0].content[1].image_url.url).toBe(
      "data:image/png;base64,aW1hZ2U=",
    );
    expect(actual.max_tokens).toBe(8192);
  });
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
    expect(endpoint("https://example.test/v1/models", "models")).toBe(
      "https://example.test/v1/models",
    );
  });
  it("使用 GET 与当前 Key 获取模型，剔除重复和无效项，不依赖已配置的模型名", async () => {
    let method = "",
      path = "",
      authorization = "";
    const url = await server((req, res) => {
      method = req.method!;
      path = req.url!;
      authorization = req.headers.authorization!;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            { id: "writer-b" },
            { id: "image-custom" },
            { id: "writer-a" },
            { id: "writer-a" },
            { id: 1 },
            { id: "  " },
            null,
          ],
        }),
      );
    });
    expect(
      await listModels({
        baseUrl: url + "/chat/completions",
        key: "qa-model-key",
      }),
    ).toEqual(["image-custom", "writer-a", "writer-b"]);
    expect(method).toBe("GET");
    expect(path).toBe("/v1/models");
    expect(authorization).toBe("Bearer qa-model-key");
  });
  it("模型列表为空、不兼容或失败时明确报错", async () => {
    const url = await server((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url?.includes("empty")) res.end('{"data":[]}');
      else if (req.url?.includes("invalid")) res.end('{"models":[]}');
      else {
        res.statusCode = 403;
        res.end('{"error":{"message":"permission denied"}}');
      }
    });
    await expect(
      listModels({ baseUrl: url + "/empty", key: "qa" }),
    ).rejects.toThrow("未返回可用模型");
    await expect(
      listModels({ baseUrl: url + "/invalid", key: "qa" }),
    ).rejects.toThrow("data 数组");
    await expect(listModels({ baseUrl: url, key: "qa" })).rejects.toThrow(
      "403",
    );
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
        JSON.stringify({
          choices: [
            { message: { content: "连接成功" }, finish_reason: "stop" },
          ],
        }),
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

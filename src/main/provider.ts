export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface Connection {
  baseUrl: string;
  model: string;
  key: string;
}

export function endpoint(baseUrl: string, path: string): string {
  const url = new URL(baseUrl.trim());
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("接口地址需要是有效的 HTTP 或 HTTPS 地址。");
  url.pathname =
    url.pathname
      .replace(
        /\/(models|chat\/completions|images\/(generations|edits))\/?$/,
        "",
      )
      .replace(/\/$/, "") +
    "/" +
    path;
  url.hash = "";
  return url.toString();
}
async function errorMessage(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const data = JSON.parse(body);
    return `接口返回 ${response.status}：${String(data.error?.message || data.message || response.statusText).slice(0, 500)}`;
  } catch {
    return `接口返回 ${response.status}，请检查地址、Key、模型名称和服务可用性。`;
  }
}
export async function listModels(
  config: Pick<Connection, "baseUrl" | "key">,
): Promise<string[]> {
  if (!config.key.trim()) throw new Error("请先填写 API Key。");
  const response = await fetch(endpoint(config.baseUrl, "models"), {
    headers: { Authorization: `Bearer ${config.key}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  let data: { data?: unknown; error?: { message?: string } };
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") throw new Error();
    data = body;
  } catch {
    throw new Error(
      "接口未返回有效 JSON，请检查模型列表地址，或手动添加模型名称。",
    );
  }
  if (data.error) throw new Error(data.error.message || "获取模型列表失败。");
  if (!Array.isArray(data.data))
    throw new Error(
      "接口未返回兼容的模型列表（data 数组）。可手动添加模型名称。",
    );
  const models = [
    ...new Set(
      data.data.flatMap((item: unknown) => {
        if (
          item &&
          typeof item === "object" &&
          "id" in item &&
          typeof item.id === "string"
        ) {
          const id = item.id.trim();
          return id && id.length <= 500 ? [id] : [];
        }
        return [];
      }),
    ),
  ].sort((a, b) => a.localeCompare(b));
  if (!models.length)
    throw new Error("服务未返回可用模型，可手动添加模型名称。");
  if (models.length > 3000)
    throw new Error(
      "服务返回的模型超过 3000 个，请使用服务商提供的精简列表地址，或手动添加模型。",
    );
  return models;
}
export async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    result = "";
  const consume = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error("模型返回了无法解析的流式数据，已保留收到的草稿。");
    }
    if (event.error)
      throw new Error(String(event.error.message || "模型生成失败。"));
    const content = event.choices?.[0]?.delta?.content;
    if (typeof content === "string") {
      result += content;
      onDelta(content);
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += chunk.done
        ? decoder.decode()
        : decoder.decode(chunk.value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) consume(block);
      if (chunk.done) {
        if (buffer.trim()) consume(buffer);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return result;
}
export function validateConnection(config: Connection) {
  if (!config.baseUrl.trim()) throw new Error("请先在设置中填写接口地址。");
  if (!config.model.trim()) throw new Error("请先在设置中填写模型名称。");
  if (!config.key.trim()) throw new Error("请先在设置中填写 API Key。");
}
export async function chat(
  config: Connection,
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  validateConnection(config);
  const response = await fetch(endpoint(config.baseUrl, "chat/completions"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: config.model, messages, stream: true }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(600_000)])
      : AbortSignal.timeout(600_000),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    if (!response.body) throw new Error("模型没有返回可读取的内容。");
    const result = await consumeSSE(response.body, onDelta);
    if (!result.trim())
      throw new Error("模型未返回正文，请检查模型是否支持聊天接口。");
    return result;
  }
  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (data.error) throw new Error(data.error.message || "模型调用失败。");
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim())
    throw new Error("接口响应中没有文字内容。请检查服务是否兼容聊天接口。");
  onDelta(text);
  return text;
}
export interface ImageInput {
  data: Uint8Array;
  name: string;
  mime: string;
}
export async function generateImage(
  config: Connection,
  prompt: string,
  size: string,
  quality: string,
  references: ImageInput[],
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; mime: string }> {
  validateConnection(config);
  let body: BodyInit;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.key}`,
  };
  if (references.length) {
    const form = new FormData();
    form.set("model", config.model);
    form.set("prompt", prompt);
    form.set("size", size);
    form.set("quality", quality);
    for (const ref of references)
      form.append(
        "image[]",
        new Blob([new Uint8Array(ref.data)], { type: ref.mime }),
        ref.name,
      );
    body = form;
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ model: config.model, prompt, size, quality, n: 1 });
  }
  const response = await fetch(
    endpoint(
      config.baseUrl,
      references.length ? "images/edits" : "images/generations",
    ),
    {
      method: "POST",
      headers,
      body,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(600_000)])
        : AbortSignal.timeout(600_000),
    },
  );
  if (!response.ok) throw new Error(await errorMessage(response));
  const data = (await response.json()) as {
    data?: { b64_json?: string; url?: string }[];
    error?: { message?: string };
  };
  if (data.error) throw new Error(data.error.message || "生图失败。");
  const image = data.data?.[0];
  if (image?.b64_json) {
    if (image.b64_json.length > 48_000_000)
      throw new Error("返回图片超过大小限制。");
    return { bytes: Buffer.from(image.b64_json, "base64"), mime: "image/png" };
  }
  if (image?.url) {
    const url = new URL(image.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("服务返回了不支持的图片地址。");
    const download = await fetch(url, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
    });
    if (!download.ok || !download.body)
      throw new Error("图片已生成，但下载失败。请检查网络和服务返回的地址。");
    const reader = download.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 32_000_000) {
          await reader.cancel();
          throw new Error("图片超过 32 MB 的大小限制。");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    return {
      bytes: Buffer.concat(chunks),
      mime: download.headers.get("content-type") || "image/png",
    };
  }
  throw new Error(
    "接口响应中没有图片数据。请检查服务是否兼容 OpenAI 图片接口。",
  );
}

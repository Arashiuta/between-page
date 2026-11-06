// Rasterize the existing vector mark with Electron's SVG renderer; no image tools needed.
const { app, BrowserWindow } = require("electron");
const { readFile, mkdir, writeFile } = require("node:fs/promises");
const { join } = require("node:path");

app
  .whenReady()
  .then(async () => {
    const root = join(__dirname, "..");
    const svg = await readFile(
      join(root, "src/renderer/assets/brand-mark.svg"),
      "utf8",
    );
    const window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true },
    });
    try {
      await window.loadURL("data:text/html,<html><body></body></html>");
      const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
      const images = await window.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
      await image.decode();
      return ${JSON.stringify(sizes)}.map(size => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        canvas.getContext('2d').drawImage(image, 0, 0, size, size);
        return canvas.toDataURL('image/png').split(',')[1];
      });
    })()`);
      const pngs = images.map((data) => Buffer.from(data, "base64"));
      const entries = pngs.slice(0, -1);
      const header = Buffer.alloc(6 + entries.length * 16);
      header.writeUInt16LE(1, 2);
      header.writeUInt16LE(entries.length, 4);
      let offset = header.length;
      entries.forEach((png, index) => {
        const entry = 6 + index * 16;
        header[entry] = header[entry + 1] = sizes[index] % 256;
        header.writeUInt16LE(1, entry + 4);
        header.writeUInt16LE(32, entry + 6);
        header.writeUInt32LE(png.length, entry + 8);
        header.writeUInt32LE(offset, entry + 12);
        offset += png.length;
      });
      await mkdir(join(root, "build"), { recursive: true });
      await writeFile(join(root, "build/icon.png"), pngs.at(-1));
      await writeFile(
        join(root, "build/icon.ico"),
        Buffer.concat([header, ...entries]),
      );
      console.log(
        "Generated build/icon.png (512px) and build/icon.ico (16–256px).",
      );
    } finally {
      window.destroy();
      app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

import { z } from "zod";
import type { CoverCrop } from "./types";

export const COVER_LIMIT = 20_000_000;
export const coverCropSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine(
    (c) => c.x + c.width <= 1.000001 && c.y + c.height <= 1.000001,
    "取景超出图片边界。",
  );
export const coverUploadSchema = z.object({
  name: z.string().max(500),
  dataUrl: z.string().max(Math.ceil(COVER_LIMIT / 3) * 4 + 100),
  crop: coverCropSchema,
});
const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));
export function cropCover(
  width: number,
  height: number,
  zoom = 1,
  cx = 0.5,
  cy = 0.5,
): CoverCrop {
  const scale = clamp(zoom, 1, 3);
  const w = Math.min(1, (2 * height) / width) / scale;
  const h = Math.min(1, width / (2 * height)) / scale;
  return {
    x: clamp(cx - w / 2, 0, 1 - w),
    y: clamp(cy - h / 2, 0, 1 - h),
    width: w,
    height: h,
  };
}
export function coverImageStyle(crop: CoverCrop) {
  return {
    width: `${100 / crop.width}%`,
    height: `${100 / crop.height}%`,
    left: `${(-100 * crop.x) / crop.width}%`,
    top: `${(-100 * crop.y) / crop.height}%`,
  };
}

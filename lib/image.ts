// Nén ảnh sang WebP trước khi lưu: giữ nguyên chất lượng nhìn thấy, dung lượng nhỏ nhất có thể.
// Thử nhiều cách mã hoá và chọn bản nhỏ nhất; nếu không bản nào nhỏ hơn ảnh gốc thì giữ ảnh gốc.
import sharp, { type WebpOptions } from 'sharp';

/** Chất lượng cho ảnh chụp (JPEG): lossy cao (q85 + smartSubsample ≈ không nhận ra khác biệt). */
const PHOTO_QUALITY = 85;
/** Mức near-lossless cho PNG/WebP: gần như không phân biệt được bằng mắt. */
const NEAR_LOSSLESS = 80;

/** Kết quả nén ảnh. */
interface CompressedImage {
  /** Nội dung ảnh sau khi nén (hoặc ảnh gốc nếu không nén được). */
  buffer: Buffer;
  /** MIME của `buffer`. */
  mime: string;
  /** Đuôi file mới (".webp") nếu đã nén, `null` nếu giữ ảnh gốc. */
  ext: string | null;
  /** Số byte tiết kiệm được (0 nếu giữ ảnh gốc). */
  saved: number;
}

/**
 * Mã hoá ảnh sang WebP với các tuỳ chọn cho trước.
 * @param input dữ liệu ảnh gốc
 * @param opts tuỳ chọn WebP (quality, lossless, nearLossless...)
 */
async function encode(input: Buffer, opts: WebpOptions): Promise<Buffer> {
  return sharp(input, { failOn: 'none', limitInputPixels: 100e6 })
    .rotate() // áp dụng EXIF orientation trước khi bỏ metadata
    .webp({ effort: 6, smartSubsample: true, ...opts })
    .toBuffer();
}

/**
 * Nén ảnh sang WebP, chọn bản nhỏ nhất. GIF (ảnh động) và ảnh lỗi được giữ nguyên.
 * @param buffer ảnh gốc
 * @param mime MIME gốc
 */
async function compressImage(buffer: Buffer, mime: string): Promise<CompressedImage> {
  const original: CompressedImage = { buffer, mime, ext: null, saved: 0 };
  if (mime === 'image/gif') return original; // giữ ảnh động nguyên vẹn
  try {
    const candidates: Promise<Buffer>[] = [];
    if (mime === 'image/jpeg') {
      candidates.push(encode(buffer, { quality: PHOTO_QUALITY }));
    } else {
      // PNG / WebP: lossless + near-lossless, lấy bản nhỏ hơn
      candidates.push(encode(buffer, { lossless: true }));
      candidates.push(encode(buffer, { lossless: true, nearLossless: true, quality: NEAR_LOSSLESS }));
    }
    const results = await Promise.all(candidates);
    const best = results.reduce((a, b) => (b.length < a.length ? b : a));
    if (best.length >= buffer.length) return original; // nén xong lại lớn hơn -> giữ ảnh gốc
    return { buffer: best, mime: 'image/webp', ext: '.webp', saved: buffer.length - best.length };
  } catch {
    return original; // ảnh lỗi/không đọc được: giữ nguyên, để luồng cũ xử lý
  }
}

export { compressImage };
export type { CompressedImage };

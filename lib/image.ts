// Nén ảnh sang WebP trước khi lưu: giữ nguyên chất lượng nhìn thấy, dung lượng nhỏ nhất có thể.
// Thử nhiều cách mã hoá và chọn bản nhỏ nhất; nếu không bản nào nhỏ hơn ảnh gốc thì giữ ảnh gốc.
import sharp from 'sharp';

// Ảnh chụp màn hình / đồ hoạ (PNG): lossless hoặc near-lossless (gần như không phân biệt được bằng mắt)
// Ảnh chụp (JPEG/WebP): lossy chất lượng cao (q85 + smartSubsample ≈ không nhận ra khác biệt)
const PHOTO_QUALITY = 85;
const NEAR_LOSSLESS = 80;

async function encode(input, opts) {
  return sharp(input, { failOn: 'none', limitInputPixels: 100e6 })
    .rotate() // áp dụng EXIF orientation trước khi bỏ metadata
    .webp({ effort: 6, smartSubsample: true, ...opts })
    .toBuffer();
}

/**
 * @param {Buffer} buffer ảnh gốc
 * @param {string} mime mime gốc
 * @returns {Promise<{buffer:Buffer, mime:string, ext:string, saved:number}>}
 */
async function compressImage(buffer, mime) {
  const original = { buffer, mime, ext: null, saved: 0 };
  if (mime === 'image/gif') return original; // giữ ảnh động nguyên vẹn
  try {
    const candidates = [];
    if (mime === 'image/jpeg') {
      candidates.push(encode(buffer, { quality: PHOTO_QUALITY }));
    } else {
      // PNG / WebP: lossless + near-lossless, lấy bản nhỏ hơn
      candidates.push(encode(buffer, { lossless: true }));
      candidates.push(encode(buffer, { lossless: true, nearLossless: true, quality: NEAR_LOSSLESS }));
    }
    const results = await Promise.all(candidates);
    const best = results.reduce((a, b) => (b.length < a.length ? b : a));
    if (best.length >= buffer.length) return original;
    return { buffer: best, mime: 'image/webp', ext: '.webp', saved: buffer.length - best.length };
  } catch (e) {
    return original; // ảnh lỗi/không đọc được: giữ nguyên, để luồng cũ xử lý
  }
}

export { compressImage };

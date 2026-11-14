// Cloudflare R2 (tương thích S3): nơi lưu ảnh / file HAR thay cho bảng `files` trong Postgres.
// Chỉ bật khi đủ các biến môi trường R2_*; thiếu một biến là tắt (app dùng Postgres/thư mục uploads như cũ).
import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { StoredFile, StoredUpload } from './blobs.js';

/** Giao diện kho file (blob) mà driver Postgres dùng khi bật R2. */
interface BlobStore {
  /** Ghi một file lên R2. */
  put(upload: StoredUpload): Promise<void>;
  /** Đọc file theo tên; không tồn tại -> null. */
  get(name: string): Promise<StoredFile | null>;
  /** Xóa nhiều file (best effort, không ném lỗi). */
  remove(names: string[]): Promise<void>;
}

/**
 * Tạo kho R2 từ biến môi trường:
 *  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
 * @returns kho R2, hoặc `null` nếu chưa cấu hình đủ.
 */
function createR2FromEnv(env: NodeJS.ProcessEnv = process.env): BlobStore | null {
  const { R2_ACCOUNT_ID: account, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey, R2_BUCKET: bucket } = env;
  if (!account || !accessKeyId || !secretAccessKey || !bucket) return null;

  const client = new S3Client({
    region: 'auto', // R2 không dùng region
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  return {
    async put(u) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: u.name, Body: u.buffer, ContentType: u.mime, ContentLength: u.size }));
    },
    async get(name) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: name }));
        if (!res.Body) return null;
        return { buffer: Buffer.from(await res.Body.transformToByteArray()), mime: res.ContentType || 'application/octet-stream' };
      } catch (e) {
        if ((e as { name?: string }).name === 'NoSuchKey') return null;
        throw e;
      }
    },
    async remove(names) {
      if (!names.length) return;
      try {
        await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: names.map((Key) => ({ Key })), Quiet: true } }));
      } catch (e) {
        console.error('[r2] không xóa được file:', (e as Error).message);
      }
    },
  };
}

export { createR2FromEnv };
export type { BlobStore };

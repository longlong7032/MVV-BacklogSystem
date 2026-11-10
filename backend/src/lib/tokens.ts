// Token cá nhân: tạo, băm, gợi ý hiển thị. Dùng chung cho server và scripts/create-admin.ts.
import crypto from 'node:crypto';

/** Tiền tố của token cá nhân, giúp nhận biết nhanh và tránh nhầm với token phiên (`fbs_`). */
const TOKEN_PREFIX = 'fbk_';

/** Tạo token cá nhân mới: tiền tố + 32 byte ngẫu nhiên mã hoá base64url. */
const newToken = (): string => TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');

/** SHA-256 (dạng Buffer) của một giá trị bất kỳ; dùng để so sánh thời gian cố định. */
const sha256 = (v: unknown): Buffer => crypto.createHash('sha256').update(String(v)).digest();

/** Băm token để lưu trong DB (chỉ lưu băm, không lưu token gốc). */
const hashToken = (token: string): string => sha256(token).toString('hex');

/** Gợi ý hiển thị token mà không lộ toàn bộ, vd "fbk_AbCd…wXyZ". */
const tokenHint = (token: string): string => token.slice(0, TOKEN_PREFIX.length + 4) + '…' + token.slice(-4);

/**
 * Băm mật khẩu quản trị bằng scrypt + salt ngẫu nhiên.
 * @returns chuỗi dạng "scrypt$<salt>$<hash>"
 */
const hashPassword = (password: string): string => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
};

/**
 * Kiểm tra mật khẩu với chuỗi băm đã lưu (so sánh thời gian cố định).
 * @param stored chuỗi "scrypt$<salt>$<hash>"; giá trị sai định dạng/rỗng -> false
 */
const verifyPassword = (password: string, stored: string | undefined): boolean => {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
};

export { TOKEN_PREFIX, newToken, sha256, hashToken, tokenHint, hashPassword, verifyPassword };

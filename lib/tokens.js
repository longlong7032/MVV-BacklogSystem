// Token cá nhân: tạo, băm, gợi ý hiển thị. Dùng chung cho server và scripts/create-admin.js.
import crypto from 'node:crypto';

const TOKEN_PREFIX = 'fbk_';

const newToken = () => TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest();
const hashToken = (token) => sha256(token).toString('hex');
const tokenHint = (token) => token.slice(0, TOKEN_PREFIX.length + 4) + '…' + token.slice(-4);

// Mật khẩu quản trị: scrypt + salt ngẫu nhiên, lưu dạng "scrypt$<salt>$<hash>"
const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
};

const verifyPassword = (password, stored) => {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
};

export { TOKEN_PREFIX, newToken, sha256, hashToken, tokenHint, hashPassword, verifyPassword };

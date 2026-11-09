// Token cá nhân: tạo, băm, gợi ý hiển thị. Dùng chung cho server và scripts/create-admin.js.
const crypto = require('crypto');

const TOKEN_PREFIX = 'fbk_';

const newToken = () => TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest();
const hashToken = (token) => sha256(token).toString('hex');
const tokenHint = (token) => token.slice(0, TOKEN_PREFIX.length + 4) + '…' + token.slice(-4);

module.exports = { TOKEN_PREFIX, newToken, sha256, hashToken, tokenHint };

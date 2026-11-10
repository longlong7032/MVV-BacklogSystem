// Xác định thư mục gốc của dự án (nơi có package.json), dùng chung cho server, scripts và mcp.
// Cần vì mã chạy ở hai nơi: trực tiếp từ nguồn (tsx: ./server.ts) và từ bản build (node: ./dist/server.js),
// nên không thể dựa vào "thư mục cha" cố định.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Đi ngược từ thư mục chứa file hiện tại cho tới khi gặp package.json.
 * @param fromUrl `import.meta.url` của file gọi hàm
 * @returns đường dẫn tuyệt đối tới thư mục gốc dự án
 */
function findRoot(fromUrl: string): string {
  let dir = path.dirname(fileURLToPath(fromUrl));
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Không tìm thấy package.json (thư mục gốc dự án).');
    dir = parent;
  }
  return dir;
}

/** Thư mục gốc dự án (chứa package.json, views/, public/, data/, uploads/). */
const ROOT_DIR = findRoot(import.meta.url);

export { ROOT_DIR, findRoot };

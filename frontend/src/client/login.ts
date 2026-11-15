/** Trang /login: chỉ gắn hành vi form đăng nhập (không nạp toàn bộ app.js vì trang không có sidebar). */
import { initGlobalErrors } from './errors.js';
import { initLogin } from './users.js';

initGlobalErrors();
initLogin();

/**
 * Điểm vào của giao diện Feedback backlog.
 *
 * HTML của mọi trang do server render bằng Handlebars (views/*.hbs). Code phía trình duyệt chỉ gắn hành vi:
 * modal và form, ảnh đính kèm, thao tác nhanh trên danh sách, đăng nhập quản trị — và gọi API `/api/...`
 * để thêm / sửa / xóa dữ liệu, sau đó tải lại trang để thấy kết quả.
 *
 * Biên dịch bằng `npm run build:client` ra public/js/ (layout.hbs nạp public/js/app.js).
 */
import { initBacklogList } from './backlog-list.js';
import { initCrud } from './crud.js';
import { initDialog } from './dialog.js';
import { initDocuments } from './documents.js';
import { initFeedbackForm } from './feedback-form.js';
import { initMcp } from './mcp.js';
import { initPaymentRounds } from './payment-rounds.js';
import { initUi } from './ui.js';
import { initUsers } from './users.js';

// Thứ tự quan trọng: crud đăng ký form dự án/team trước, form backlog và người dùng đăng ký sau
initDialog();
initUi();
initCrud();
initFeedbackForm();
initUsers();
initBacklogList();
initMcp();
initPaymentRounds();
initDocuments();

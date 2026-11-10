# Feedback backlog

Express + HBS + Tailwind (CDN), render phía client (CSR).

## Chạy

```bash
npm install
npm start        # http://localhost:3000  (đổi cổng: PORT=4000 npm start)
npm run dev      # tự restart khi sửa code (Node 18.11+)
```

## Deploy lên Vercel + Postgres (Neon)

Vercel không cho ghi file, nên khi có biến kết nối Postgres app tự chuyển sang lưu **toàn bộ dữ liệu và ảnh vào Postgres**. Không có biến này (chạy local) app vẫn dùng file `data/db.json` + thư mục `uploads/` như cũ, nên chạy thử local **không đụng dữ liệu production**.

1. **Biến môi trường trên Vercel** (Project → Settings → Environment Variables):

   | Biến | Ghi chú |
   |---|---|
   | `DATABASE_URL` | Chuỗi kết nối Postgres (Neon). Cũng nhận `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, `NEON_DATABASE_URL` hoặc biến nào có dạng `postgresql://...` |
   | `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Admin cứng — **đặt mật khẩu mạnh, khác môi trường local** |
   | `PUBLIC_URL` | Không bắt buộc, vd `https://mvv-backlog.vercel.app` |

2. Push code lên GitHub, Vercel tự build. Cấu hình nằm ở `vercel.json` + `api/index.js` (Express chạy như một serverless function). Bảng `app_state` và `files` được tạo tự động ở lần chạy đầu tiên.
3. **Chuyển dữ liệu local lên** (một lần, không bắt buộc):

   ```bash
   DATABASE_URL="postgresql://..." npm run migrate-to-pg -- --dry-run   # xem sẽ chuyển gì
   DATABASE_URL="postgresql://..." npm run migrate-to-pg                # chuyển thật (từ chối nếu DB đã có dữ liệu)
   ```

**Giới hạn trên Vercel:** mỗi request tối đa ~4.5MB, nên ảnh được tự thu nhỏ (tối đa 1600px) ngay trên trình duyệt và tổng ảnh mỗi lần lưu tối đa ~4MB. File HAR từ extension Chrome lớn hơn mức này sẽ bị từ chối. Giới hạn tốc độ (rate limit) đếm riêng theo từng instance. Biến `PG_POOL_MAX` (mặc định 4) chỉnh số kết nối DB mỗi instance.

## Cấu trúc

```
server.js            API + upload ảnh (multer) + MCP; export app cho Vercel
lib/store.js         lưu trữ: Postgres (có DATABASE_URL) hoặc file JSON (local)
api/index.js         điểm vào của Vercel (vercel.json rewrite mọi request về đây)
views/layout.hbs     layout, nạp Tailwind
views/index.hbs      khung trang (toolbar, bảng, form, lightbox)
public/js/app.js     toàn bộ render + logic phía client
chrome-extension/    extension Chrome báo lỗi nhanh khi test
data/db.json         dữ liệu (tự tạo)
uploads/             ảnh đính kèm
```

## Chức năng

- **Dự án** (tab "Dự án", `#/projects`): thêm / sửa / xóa dự án (tên không trùng, mô tả). Bảng hiển thị tiến độ backlog (% hoàn thành, số chưa làm / đang làm). Xóa dự án sẽ xóa luôn toàn bộ backlog và ảnh của dự án đó (có xác nhận).
- **Backlog** (tab "Backlog", `#/backlog`): thêm / sửa / xóa backlog, lọc theo dự án, theo trạng thái, tìm kiếm.
- **Trạng thái**: `Chưa làm` · `Đang làm` · `Đã hoàn thành` — đổi trực tiếp ngay trên bảng (dropdown ở cột Trạng thái) hoặc trong form. Khi chuyển sang hoàn thành sẽ lưu ngày hoàn thành.

## Cột dữ liệu backlog

| Cột | Nội dung |
|---|---|
| Mã dự án + Tên dự án | Chọn từ danh sách dự án (mã dự án không bắt buộc, không trùng; có nút "+ Dự án mới" ngay trong form) |
| STT | Tự tăng theo từng dự án |
| Loại | App customer, Website admin... — chọn gợi ý hoặc nhập loại mới, các loại đã dùng được gợi ý lại |
| Team xử lý | Chọn từ danh sách team (đổi nhanh ngay trong bảng) |
| Trạng thái | todo / doing / done |
| Tên lỗi | Tóm tắt ngắn (tối đa 200 ký tự) |
| Vị trí lỗi | URL và/hoặc 1 ảnh (+ file HAR nếu có) |
| Mô tả lỗi | Text + tối đa 10 ảnh |
| Kết quả mong muốn | Text + tối đa 10 ảnh |
| Ghi chú | Text, không bắt buộc |

File Excel xuất ra có cột theo đúng thứ tự trên (Mã dự án, Tên dự án, STT, Loại, Team, Trạng thái, Tên lỗi, Vị trí lỗi, Mô tả lỗi, Kết quả mong muốn, Ghi chú...).

Ảnh: chọn file, kéo thả, hoặc dán từ clipboard (Ctrl+V) vào vùng đang trỏ chuột/focus.

Dữ liệu cũ (feedback lưu tên dự án) được tự động chuyển sang dạng mới khi khởi động: tạo dự án tương ứng, gắn `projectId`, trạng thái mặc định `todo`.

## API

Dự án (JSON):

- `GET    /api/projects`
- `POST   /api/projects` `{ name, description }`
- `PUT    /api/projects/:id` `{ name, description }`
- `DELETE /api/projects/:id` (xóa kèm backlog của dự án)

Backlog:

- `GET    /api/feedbacks`
- `POST   /api/feedbacks` (multipart: project_id, status, location_url, location_image, bug_text, bug_images, expected_text, expected_images, har_file)
- `PUT    /api/feedbacks/:id` (như POST, thêm remove_location_image=1, remove_bug_images=[urls], remove_expected_images=[urls], remove_har=1)
- `PATCH  /api/feedbacks/:id/status` `{ status: "todo" | "doing" | "done" }`
- `DELETE /api/feedbacks/:id`

`har_file`: file HAR (log mạng) tối đa 50MB, lưu ở `har: { url, name, size }` (ảnh vẫn giới hạn 10MB).

## Extension Chrome (báo lỗi nhanh khi test)

Cài đặt:

1. Mở `chrome://extensions`, bật **Developer mode**.
2. Bấm **Load unpacked** → chọn thư mục `chrome-extension/`.
3. Ghim extension lên thanh công cụ. Mặc định extension gửi tới `http://localhost:3000`; đổi trong mục **Cài đặt** ở cuối popup.

Cách dùng: đang test gặp lỗi → bấm icon extension (hoặc **Alt+Shift+B**) → form mở ra với:

- **Dự án**: nhớ dự án đã chọn lần trước.
- **Vị trí**: tự điền URL của tab hiện tại.
- **Mô tả lỗi / Kết quả mong muốn**: có thể dán ảnh (Ctrl/⌘+V) hoặc chọn ảnh.
- **Ảnh chụp màn hình**: tự chụp trang hiện tại, gửi kèm vào "Mô tả lỗi" (bỏ tick nếu không muốn).
- **File HAR**: chọn *Gửi kèm HAR* hoặc *Không gửi HAR* (nhớ lựa chọn lần trước).
  - Nếu **DevTools đang mở** trên tab đó: HAR lấy từ tab Network, có cả response body (giống *Export HAR*).
  - Nếu không: dùng log extension ghi ngầm (300 request gần nhất của tab), có URL / method / header / status / thời gian / request body nhưng **không có response body**.
  - Mặc định ẩn Cookie / Authorization / token trong HAR.
  - Nút "Xoá log mạng" để xoá log cũ trước khi tái hiện lỗi.

Popup tự đóng khi bấm ra ngoài; nội dung đang nhập được giữ lại làm nháp cho tab đó. File HAR tải về từ cột Vị trí trong bảng backlog, mở bằng DevTools → Network → Import HAR.

## MCP cho team dev

MCP chạy **ngay trong web app** tại `POST /mcp` (Streamable HTTP) nên khi deploy dev chỉ cần URL, không cài gì thêm. Hướng dẫn chi tiết cho từng công cụ nằm ở trang **Kết nối MCP** (`#/mcp`) trong web app.

```bash
claude mcp add --transport http feedback-backlog https://<host>/mcp --header "Authorization: Bearer <token cá nhân>"
```

**Người dùng & token cá nhân:** trang **Người dùng** (`#/users`) cho phép thêm / sửa / vô hiệu hóa / xóa người dùng; mỗi người có **1 token riêng** (`fbk_…`), hiển thị đúng một lần khi tạo hoặc cấp lại (DB chỉ lưu băm SHA-256). Có thể thu hồi / cấp lại token và đặt vai trò theo từng người:

| Vai trò | MCP | Trang Người dùng |
|---|---|---|
| Chỉ đọc | 5 tool đọc | — |
| Đọc + ghi | + đổi trạng thái, giao team | — |
| Quản trị viên | như Đọc + ghi | Quản lý người dùng, cấp / thu hồi token |

Quản trị viên đăng nhập trang Người dùng bằng **email + mật khẩu** (admin cứng đặt trong `.env`, xem bên dưới) hoặc bằng **token cá nhân**. Ngoài ra có thể tạo admin bằng lệnh chạy trên server:

```bash
npm run create-admin -- "Họ tên" email@congty.vn   # in token một lần; chạy lại với email cũ = cấp lại token
```

Không thể xóa / hạ quyền / vô hiệu hóa / thu hồi token của quản trị viên hoạt động cuối cùng. Mọi thao tác quản trị được ghi vào "Nhật ký hoạt động" trên trang Người dùng; thay đổi trạng thái / giao team qua MCP ghi nhận "cập nhật bởi <tên>".

**Biến môi trường khi deploy**

| Biến | Tác dụng |
|---|---|
| `ADMIN_EMAIL` + `ADMIN_PASSWORD` | Admin cứng: mỗi lần khởi động đảm bảo tài khoản này là admin đang hoạt động với đúng mật khẩu (tối thiểu 8 ký tự, lưu dạng băm scrypt). `ADMIN_NAME` đặt tên hiển thị. Đổi mật khẩu trong `.env` rồi khởi động lại |
| `MCP_READONLY=1` | Ép toàn server chỉ đọc, bất kể quyền từng người |
| `PUBLIC_URL` | Địa chỉ công khai của web app, dùng dựng link ảnh / HAR (mặc định lấy theo request) |
| `TRUST_PROXY` | Số proxy phía trước app (mặc định 1 = nginx). Không có proxy thì đặt `0` |
| `DEV_NO_AUTH=1` | Chỉ để thử local: bỏ xác thực trang Người dùng và `/mcp`. Không bật khi deploy |

**Chống lạm dụng / sập server:** 60 request/phút/IP và 300 request/phút toàn server; sai token > 8 lần → khóa IP 15 phút; tối đa 8 request MCP đồng thời; timeout 60s; HAR tối đa 20MB, ảnh 5MB/ảnh; kết quả trả về cắt ở 100K ký tự; lỗi bất ngờ chỉ ghi log, không làm tắt tiến trình.

Sau nginx / load balancer: bật HTTPS, chuyển tiếp `Host` + `X-Forwarded-Proto`, đặt `proxy_buffering off;` cho `/mcp`. Token cá nhân chỉ bảo vệ `/mcp` và trang Người dùng; các `/api/*` và giao diện web chưa có đăng nhập nên nên đặt web app sau VPN / SSO.

**Tool:** `list_projects`, `list_teams`, `list_backlog`, `get_backlog` (kèm ảnh), `analyze_har`, `update_backlog_status`, `assign_backlog_team`.

Chạy local kiểu stdio vẫn dùng được: `BACKLOG_URL=http://localhost:3000 node mcp/server.js`.

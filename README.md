# Feedback backlog

Hệ thống ghi nhận và theo dõi backlog lỗi theo dự án. Viết bằng **TypeScript**, gồm 3 project độc lập trong cùng repo — mỗi thư mục có `package.json` riêng nên sau này tách thành các repo khác nhau chỉ cần copy thư mục:

| Thư mục | Vai trò | Công nghệ |
|---|---|---|
| [`backend/`](backend) | **API JSON** + upload ảnh + MCP. Dữ liệu trong Postgres (bảng thật, xóa mềm), file trên Cloudflare R2 hoặc Postgres. Không có giao diện. | Express + pg |
| [`frontend/`](frontend) | **Giao diện**: server render HTML bằng Handlebars, gọi backend qua HTTP; JS phía trình duyệt gọi API để thêm / sửa / xóa. | Express + Handlebars + Tailwind (CDN) |
| [`chrome-extension/`](chrome-extension) | Extension Chrome báo lỗi nhanh khi test (chụp màn hình + HAR). | Chrome MV3 |

```
Trình duyệt ──► frontend (:4000) ──┬─ render trang (hbs), lấy dữ liệu từ backend qua HTTP
                                   └─ proxy /api, /uploads, /mcp ──► backend (:3000) ──► Postgres (+ R2)
```

Frontend **không đọc DB và không import code của backend**; hai bên chỉ giao tiếp qua API (`/api/...`). Kiểu dữ liệu của API nằm ở `backend/src/types.d.ts` (frontend và extension giữ bản sao `src/types.d.ts` — khi đổi API nhớ cập nhật cả hai).

**Thiết kế schema + API chi tiết: [docs/API.md](docs/API.md).** Mọi bảng có `id_private` (khóa nội bộ, không ra API), `id_public` (UUID v7, dùng trên API là `idPublic`), `created_at`, `updated_at`, `deleted_at` (xóa mềm).

## Chạy local

```bash
npm run install:all      # cài thư viện cho backend, frontend, extension
npm run build            # biên dịch cả 3 project

# Postgres local (Docker) — lần đầu
docker compose up -d     # Postgres 17 ở localhost:5433 (xem docker-compose.yml)
cp backend/.env.example backend/.env   # DATABASE_URL đã trỏ sẵn tới Postgres local

# Terminal 1 — backend (mặc định :3000; cấu hình trong backend/.env)
npm run dev:backend
# Terminal 2 — frontend (mặc định :4000; cấu hình trong frontend/.env, BACKEND_URL=http://localhost:3000)
cp frontend/.env.example frontend/.env   # lần đầu
npm run dev:frontend
```

Mở http://localhost:4000. Chạy bản build: `npm run start:backend` và `npm run start:frontend`. Kiểm tra kiểu: `npm run typecheck`.

- Giao diện là các file `frontend/views/*.hbs` + `views/partials/*.hbs`: sửa rồi tải lại trang là thấy. Sửa `frontend/src/client/*.ts` thì chạy lại `npm --prefix frontend run build:client`.
- Mỗi project cũng chạy độc lập: `cd backend && npm run dev`, `cd frontend && npm run dev`.
- Schema tự migrate khi backend khởi động (hoặc chạy tay `npm --prefix backend run db:migrate`). Xóa sạch dữ liệu local: `docker compose down -v`.
- Tạo admin bằng dòng lệnh: `npm --prefix backend run create-admin -- "Họ tên" email@congty.vn` (in token một lần).

## Biến môi trường

| Project | File | Biến chính |
|---|---|---|
| backend | `backend/.env` (mẫu: `backend/.env.example`) | `PORT`, `DATABASE_URL` (**bắt buộc**), `R2_*`, `ADMIN_EMAIL` / `ADMIN_PASSWORD`, `PUBLIC_URL`, `MCP_READONLY`, `TRUST_PROXY` |
| frontend | `frontend/.env` (mẫu: `frontend/.env.example`) | `PORT`, `BACKEND_URL`, `TRUST_PROXY`, `PUBLIC_URL` |

`PUBLIC_URL` của backend nên là địa chỉ công khai của **frontend** (vì ảnh / HAR được phục vụ qua `/uploads/...` của frontend khi MCP dựng link).

## Deploy lên Vercel + Postgres (Neon)

Deploy thành **2 project Vercel**, root directory lần lượt là `backend` và `frontend` (mỗi project có `vercel.json` + `api/index.js` riêng).

Backend bắt buộc có Postgres (`DATABASE_URL`). Điền thêm 4 biến `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` thì **ảnh / HAR / tài liệu lưu trên Cloudflare R2** (bucket private, backend tự phục vụ qua `/uploads/...`); không có thì bytes nằm trong bảng `files` của Postgres. Chạy local dùng Postgres Docker riêng nên **không đụng dữ liệu production**.

1. **Project backend** — Environment Variables:

   | Biến | Ghi chú |
   |---|---|
   | `DATABASE_URL` | Chuỗi kết nối Postgres (Neon). Cũng nhận `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, `NEON_DATABASE_URL` hoặc biến nào có dạng `postgresql://...` |
   | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare R2 (không bắt buộc) |
   | `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Admin cứng — **đặt mật khẩu mạnh, khác môi trường local** |
   | `PUBLIC_URL` | Địa chỉ công khai của frontend, vd `https://mvv-backlog.vercel.app` |

2. **Project frontend** — Environment Variables: `BACKEND_URL` (địa chỉ project backend, vd `https://mvv-backlog-api.vercel.app`) và tùy chọn `PUBLIC_URL`.
3. Push code lên GitHub, Vercel tự build. Các bảng được tạo tự động (migration) ở request đầu tiên.
4. **Nâng cấp từ bản cũ (1 dòng JSON trong bảng `app_state`)**: lần chạy đầu, migration tự đổi tên bảng cũ thành `legacy_app_state` / `legacy_files` (không xóa) và ứng dụng bắt đầu với **dữ liệu trống**. Khi chắc chắn không cần dữ liệu cũ: `DROP TABLE IF EXISTS legacy_app_state, legacy_files;`

**Giới hạn trên Vercel:** mỗi request tối đa ~4.5MB, nên ảnh được tự thu nhỏ (cạnh dài tối đa 2560px) ngay trên trình duyệt và tổng ảnh mỗi lần lưu tối đa ~4MB. File HAR từ extension Chrome lớn hơn mức này sẽ bị từ chối. Giới hạn tốc độ (rate limit) đếm riêng theo từng instance. Biến `PG_POOL_MAX` (mặc định 3 trên Vercel, 10 khi chạy thường) chỉnh số kết nối DB mỗi instance.

## Cấu trúc

```
backend/
  src/server.ts         khởi tạo app, gắn router, /uploads, MCP; export app cho Vercel
  src/db/*.ts           kết nối + transaction (pool.ts), migration (migrations.ts, migrate.ts)
  src/modules/*.ts      API theo module: projects, teams, feedbacks, payments, documents, users, activity
  src/types.d.ts        kiểu dữ liệu của API (DTO)
  src/lib/*.ts          file (blobs, upload, R2), UUID v7, nén ảnh, token, tiện ích HTTP
  src/mcp/server.ts     MCP server (các tool cho Claude Code / Cursor)
  src/scripts/*.ts      create-admin
  api/index.js          điểm vào của Vercel (import dist/server.js)
docker-compose.yml      Postgres cho dev local
docs/API.md             thiết kế schema + API
frontend/
  src/server.ts         Express: proxy /api /uploads /mcp sang backend + render trang
  src/backend.ts        hàm gọi backend qua HTTP (chuyển tiếp cookie)
  src/pages/*.ts        route các trang + dữ liệu hiển thị (lọc, phân trang, tiến độ)
  views/*.hbs           HTML từng trang (Handlebars); views/partials/*.hbs là mảnh dùng chung
  src/client/*.ts       JS phía trình duyệt (modal, form, ảnh, kéo thả), build ra public/js/
chrome-extension/       extension Chrome (mã nguồn src/*.ts, build ra *.js cùng thư mục)
```

## Chức năng

- **Tổng quan** (`/dashboard`): khối lượng theo team, tiến độ theo dự án.
- **Backlog** (`/backlog`): danh sách tóm tắt (lỗi / mong muốn / ảnh), lọc theo trạng thái, dự án, team, loại; chế độ Bảng / Kanban (kéo thả đổi trạng thái); modal chi tiết đổi trạng thái nhanh; xuất Excel.
- **Dự án** (`/projects`, `/projects/:id`): thông tin, nhân sự, vai trò (dùng làm "Loại" của backlog); các tab Tổng quan ("Cần chú ý"), Backlog, Thanh toán, Tài liệu PTYC, Lịch sử.
- **Tài liệu PTYC** (`/requirements`): tải tài liệu, nhiều phiên bản, trạng thái Nháp / Chờ duyệt / Đã duyệt.
- **Thanh toán** (`/payments`): tổng hợp đã thu / còn phải thu của mọi dự án (sửa trong tab Thanh toán của dự án).
- **Team xử lý** (`/teams`), **Nhân sự** (`/people`: dự án tham gia, mức tải việc), **Người dùng & token** (`/users`), **Kết nối MCP** (`/mcp-guide`).

Ảnh: chọn file, kéo thả, hoặc dán từ clipboard (Ctrl+V) vào vùng đang trỏ chuột/focus. Danh sách API: [docs/API.md](docs/API.md).

## Extension Chrome (báo lỗi nhanh khi test)

Cài đặt:

1. Mở `chrome://extensions`, bật **Developer mode**.
2. Chạy `npm --prefix chrome-extension run build` (biên dịch `chrome-extension/src/*.ts` ra `background.js`, `popup.js`, `devtools.js`).
3. Bấm **Load unpacked** → chọn thư mục `chrome-extension/`. Sau mỗi lần sửa code, build lại rồi bấm Reload ở trang `chrome://extensions`.
4. Ghim extension lên thanh công cụ. Mặc định extension gửi tới `http://localhost:3000`; đổi trong mục **Cài đặt** ở cuối popup.

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

MCP chạy **ngay trong web app** tại `POST /mcp` (Streamable HTTP) nên khi deploy dev chỉ cần URL, không cài gì thêm. Hướng dẫn chi tiết cho từng công cụ nằm ở trang **Kết nối MCP** (`/mcp-guide`) trong web app.

```bash
claude mcp add --transport http feedback-backlog https://<host>/mcp --header "Authorization: Bearer <token cá nhân>"
```

**Người dùng & token cá nhân:** trang **Người dùng** (`/users`) cho phép thêm / sửa / vô hiệu hóa / xóa người dùng; mỗi người có **1 token riêng** (`fbk_…`), hiển thị đúng một lần khi tạo hoặc cấp lại (DB chỉ lưu băm SHA-256). Có thể thu hồi / cấp lại token và đặt vai trò theo từng người:

| Vai trò | MCP | Trang Người dùng |
|---|---|---|
| Chỉ đọc | 5 tool đọc | — |
| Đọc + ghi | + đổi trạng thái, giao team | — |
| Quản trị viên | như Đọc + ghi | Quản lý người dùng, cấp / thu hồi token |

Quản trị viên đăng nhập trang Người dùng bằng **email + mật khẩu** (admin cứng đặt trong `.env`, xem bên dưới) hoặc bằng **token cá nhân**. Ngoài ra có thể tạo admin bằng lệnh chạy trên server:

```bash
npm --prefix backend run create-admin -- "Họ tên" email@congty.vn   # in token một lần; chạy lại với email cũ = cấp lại token
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

Chạy local kiểu stdio vẫn dùng được: `BACKLOG_URL=http://localhost:3000 npx tsx backend/src/mcp/server.ts`.

# Thiết kế dữ liệu & API — Feedback backlog

Backend lưu dữ liệu trong **Postgres** (bảng thật, có khóa ngoại). Schema được tạo / nâng cấp tự động bằng migration
(`backend/src/db/migrations.ts`) khi backend khởi động hoặc khi chạy `npm --prefix backend run db:migrate`.

## 1. Quy ước chung

### Cột bắt buộc của mọi bảng

| Cột DB | Kiểu | Ý nghĩa | Trong API |
|---|---|---|---|
| `id_private` | `BIGINT GENERATED ALWAYS AS IDENTITY`, khóa chính | Khóa nội bộ, dùng cho khóa ngoại / join | **Không bao giờ trả ra** |
| `id_public` | `UUID` (v7, sinh ở ứng dụng), `UNIQUE` | Định danh công khai trên URL / API | `idPublic` |
| `created_at` | `TIMESTAMPTZ`, mặc định `now()` | Thời điểm tạo | `createdAt` (ISO-8601) |
| `updated_at` | `TIMESTAMPTZ`, trigger `set_updated_at()` tự cập nhật | Thời điểm sửa gần nhất | `updatedAt` |
| `deleted_at` | `TIMESTAMPTZ NULL` | Xóa mềm: `NULL` = còn hiệu lực | Không trả về (bản đã xóa bị lọc) |

- **Xóa = xóa mềm** (đặt `deleted_at`). Mọi truy vấn đọc lọc `deleted_at IS NULL`. Xóa bản ghi cha thì xóa mềm luôn bản ghi con
  (vd xóa dự án → backlog, tệp đính kèm, đợt thanh toán, tài liệu, thành viên, vai trò).
- **Không trùng** (tên dự án / team, mã dự án, email...) dùng *partial unique index* `... WHERE deleted_at IS NULL`, nên bản ghi đã xóa
  không chặn việc tạo lại cùng tên. Ứng dụng còn so sánh tên không phân biệt hoa/thường và dấu để báo lỗi dễ hiểu.
- **UUID v7**: 48 bit đầu là thời gian (ms) → tăng dần (index gọn, sắp xếp được) nhưng vẫn không đoán được.
- **Tham chiếu trong API** (`projectId`, `teamId`, `assigneeId`, ...) luôn là `idPublic` của bản ghi kia; chuỗi rỗng `''` = không có.
- **Ngày** (không giờ): `'YYYY-MM-DD'` hoặc `''`. **Tiền** (VND): số nguyên (`BIGINT`).
- **Transaction**: mỗi request ghi (POST / PUT / PATCH / DELETE) chạy trong một transaction; lỗi → rollback toàn bộ (kể cả file vừa tải lên).
- **Lỗi**: HTTP 4xx/5xx kèm `{ "error": "thông điệp tiếng Việt", "code"?: "..." }`.

### Sơ đồ quan hệ

```
teams ─┬─< users ─┬─< sessions
       │          ├─< project_members >─┐
       │          └──────────────┐      │
       └─< feedbacks >───────────┘(assignee)
             │  └─< feedback_attachments >── files
projects ─┬─< feedbacks
          ├─< project_members
          ├─< project_roles
          ├─< payment_rounds ──(image)── files
          ├─< documents ─< document_versions >── files
          └─< activity_logs
audit_logs, schema_migrations (độc lập)
```

## 2. Bảng

Ngoài 5 cột chuẩn ở trên:

| Bảng | Cột chính |
|---|---|
| `teams` | `name` (≤120, không trùng), `lead`, `description` |
| `users` | `name`, `email` (không trùng), `role` (`read`/`write`/`admin`), `team_id` → teams, `active`, `token_hash` / `token_hint` / `token_created_at` / `last_used_at` (token cá nhân, chỉ lưu băm SHA-256), `password_hash` (scrypt) |
| `sessions` | `user_id` → users, `token_hash` (băm token phiên `fbs_…`), `expires_at` (8 giờ) |
| `files` | `storage_key` (tên trong URL `/uploads/<storage_key>`), `storage` (`r2` / `db`), `mime`, `size`, `original_name`, `data` (bytea khi không dùng R2) |
| `projects` | `code` (≤30, chữ hoa, không trùng), `name` (không trùng), `description`, `total_value`, `start_date`, `deadline` (≥ start_date), `invoice_feedback_id` → feedbacks |
| `project_members` | `project_id` → projects, `user_id` → users (không trùng cặp) |
| `project_roles` | `project_id`, `name` (≤60, không trùng trong dự án), `description`, `sort_order` — dùng làm "Loại" của backlog |
| `feedbacks` | `project_id`, `team_id`, `assignee_id`, `stt` (tăng theo dự án, không tái sử dụng), `title`, `type`, `status` (`todo`/`doing`/`done`), `location_url`, `bug_text`, `expected_text`, `note`, `completed_at`, `updated_by` |
| `feedback_attachments` | `feedback_id`, `file_id`, `kind` (`location`/`bug`/`expected`/`har`), `sort_order` |
| `payment_rounds` | `project_id`, `stt`, `name`, `amount`, `note`, `paid_at`, `paid`, `company_account`, `image_file_id` → files, `invoice_feedback_id` → feedbacks |
| `documents` | `project_id`, `title`, `doc_type`, `status` (`draft`/`review`/`approved`), `note` |
| `document_versions` | `document_id`, `file_id`, `version` (vd `v1.0`), `note`, `uploaded_by` |
| `activity_logs` | `project_id`, `entity_type` (`backlog`/`payment`/`ptyc`/`project`), `entity_public_id`, `entity_title`, `action`, `actor`, `details` (jsonb) |
| `audit_logs` | `actor`, `action`, `target` — nhật ký quản trị |
| `schema_migrations` | `name` — migration đã chạy |

## 3. API

Tất cả dưới `/api`. Body JSON trừ khi ghi *multipart*. `:id` = `idPublic`.

### Dự án
| Method | Đường dẫn | Body / Query | Kết quả |
|---|---|---|---|
| GET | `/projects` | | `Project[]` |
| GET | `/projects/:id` | | `Project` |
| POST | `/projects` | `{ code?, name, description?, totalValue?, startDate?, deadline?, memberIds?: idPublic[], roles?: {name, description}[] }` | `201 Project` |
| PUT | `/projects/:id` | như POST (thay toàn bộ thành viên + vai trò) | `Project` |
| DELETE | `/projects/:id` | | `{ ok, removedFeedbacks }` |
| POST | `/projects/:id/invoice-task` | | `201 Feedback` (việc xuất hóa đơn tổng) |

`Project = { idPublic, createdAt, updatedAt, code, name, description, totalValue, startDate, deadline, memberIds, roles: {idPublic, name, description}[], invoiceFeedbackId }`

### Team
| GET `/teams` | POST `/teams` `{ name, lead?, description? }` | PUT `/teams/:id` | DELETE `/teams/:id` → `{ ok, unassigned }` (backlog của team về "chưa phân công") |
|---|---|---|---|

### Backlog
| Method | Đường dẫn | Body / Query |
|---|---|---|
| GET | `/feedbacks` | `?project=<idPublic>` |
| POST | `/feedbacks` | *multipart*: `project_id`, `team_id`, `assignee_id`, `status`, `title`, `type`, `note_text`, `location_url`, `bug_text`, `expected_text`, `location_image`, `bug_images[]` (≤10), `expected_images[]` (≤10), `har_file` (≤50MB) |
| PUT | `/feedbacks/:id` | như POST + `remove_location_image=1`, `remove_bug_images=["/uploads/…"]`, `remove_expected_images=[…]`, `remove_har=1`; đổi dự án → cấp STT mới |
| PATCH | `/feedbacks/:id/status` | `{ status }` |
| PATCH | `/feedbacks/:id/team` | `{ team_id }` |
| DELETE | `/feedbacks/:id` | |
| GET | `/export` | `?project&team&type&status&q` → file `.xlsx` |

`Feedback = { idPublic, createdAt, updatedAt, projectId, teamId, assigneeId, stt, title, type, note, status, location: {url, image}, bug: {text, images[]}, expected: {text, images[]}, har: {url, name, size} | null, completedAt, updatedBy }`

### Đợt thanh toán
| Method | Đường dẫn | Body |
|---|---|---|
| GET | `/payments` | `?project=<idPublic>` |
| POST | `/payments` | *multipart*: `project_id`, `name`, `amount`, `note`, `paid_at`, `paid=1`, `company_account=1`, `payment_image` (đã thu thì bắt buộc ngày + ảnh) |
| PUT | `/payments/:id` | như POST (không đổi dự án) + `remove_image=1` |
| PATCH | `/payments/:id/status` | `{ paid: boolean }` |
| POST | `/payments/:id/invoice-task` | → `201 Feedback` (chỉ đợt đã thu qua tài khoản công ty, mỗi đợt một lần) |
| DELETE | `/payments/:id` | |

### Tài liệu PTYC
| Method | Đường dẫn | Body |
|---|---|---|
| GET | `/documents` | `?project=<idPublic>` |
| POST | `/documents` | *multipart*: `project_id`, `title`, `doc_type`, `status`, `note`, `version` (mặc định `v1.0`), `version_note`, `document_file` (bắt buộc; pdf, doc(x), xls(x), ppt(x), txt, md, ảnh, zip) |
| PUT | `/documents/:id` | `{ title, docType, status, note }` |
| PATCH | `/documents/:id/status` | `{ status: 'draft' \| 'review' \| 'approved' }` |
| POST | `/documents/:id/versions` | *multipart*: `version`, `version_note`, `document_file` — tài liệu đang "Đã duyệt" chuyển về "Chờ duyệt" |
| DELETE | `/documents/:id` | xóa mềm tài liệu + phiên bản |

`ProjectDocument = { idPublic, createdAt, updatedAt, projectId, title, docType, status, note, versions: { idPublic, createdAt, updatedAt, version, note, uploadedBy, file: {url, name, size, mime} }[] }` (phiên bản mới nhất trước)

### Nhật ký, nhân sự, người dùng
| Method | Đường dẫn | Ghi chú |
|---|---|---|
| GET | `/activity` | `?project=` — 300 dòng mới nhất |
| GET | `/project-members` | nhân sự đang hoạt động `{ idPublic, name, teamId, role }` (không có email) |
| POST | `/admin/login` | `{ email, password }` hoặc `{ token }` → cookie `fb_admin` (HttpOnly, 8 giờ) |
| DELETE | `/admin/session` | đăng xuất |
| GET / POST | `/users` | *(admin)* danh sách / tạo (trả token một lần) |
| PUT / DELETE | `/users/:id` | *(admin)* sửa / xóa mềm — không cho mất admin hoạt động cuối cùng |
| POST / DELETE | `/users/:id/token` | *(admin)* cấp lại / thu hồi token |
| GET | `/users/audit` | *(admin)* 50 dòng nhật ký quản trị |
| GET | `/mcp-info` | cấu hình MCP + giới hạn upload |

### File & MCP
- `GET /uploads/<storage_key>` — tải file (ảnh hiển thị trực tiếp; file khác tải về).
- `POST /mcp` — MCP Streamable HTTP, header `Authorization: Bearer <token cá nhân>`.

/**
 * Migration SQL theo thứ tự (chạy một lần, ghi lại trong bảng schema_migrations — xem migrate.ts).
 * Để trong file .ts (không phải .sql) để bản build trên Vercel luôn kèm theo, không cần copy file.
 *
 * QUY ƯỚC CHO MỌI BẢNG
 *  - id_private  BIGINT IDENTITY  khóa chính, chỉ dùng nội bộ (join, khóa ngoại) — KHÔNG BAO GIỜ trả ra API
 *  - id_public   UUID (v7)        định danh công khai trên API / URL, sinh ở ứng dụng (lib/ids.ts)
 *  - created_at, updated_at       timestamptz; updated_at tự cập nhật bằng trigger set_updated_at()
 *  - deleted_at                   xóa mềm: NULL = còn hiệu lực; mọi truy vấn đọc lọc `deleted_at IS NULL`
 *  - Ràng buộc "không trùng" dùng partial unique index ... WHERE deleted_at IS NULL (bản ghi đã xóa không chặn tạo lại)
 *  - Khóa ngoại trỏ tới id_private của bảng cha.
 */

export interface Migration {
  /** Mã migration, tăng dần, không đổi sau khi đã chạy trên production. */
  id: string;
  sql: string;
}

/** Cột chuẩn cho mọi bảng. */
const STD = `
  id_private  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_public   UUID NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ`;

/** Trigger cập nhật updated_at cho một bảng. */
const touch = (table: string): string =>
  `CREATE TRIGGER ${table}_set_updated_at BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION set_updated_at();`;

const TABLES = [
  'teams', 'users', 'sessions', 'files', 'projects', 'project_members', 'project_roles', 'feedbacks',
  'feedback_attachments', 'payment_rounds', 'documents', 'document_versions', 'activity_logs', 'audit_logs',
];

export const MIGRATIONS: Migration[] = [
  {
    id: '001_init',
    sql: `
-- Database từ phiên bản cũ (toàn bộ dữ liệu trong 1 dòng JSON app_state + bảng files dạng cũ):
-- đổi tên thành legacy_* để không chặn schema mới và không mất dữ liệu cũ. Xóa tay khi chắc chắn không cần:
--   DROP TABLE IF EXISTS legacy_app_state, legacy_files;
DO $legacy$
BEGIN
  IF to_regclass('app_state') IS NOT NULL THEN
    ALTER TABLE app_state RENAME TO legacy_app_state;
  END IF;
  IF to_regclass('files') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'files' AND column_name = 'id_private'
  ) THEN
    ALTER TABLE files RENAME TO legacy_files;
  END IF;
END
$legacy$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Team xử lý backlog
CREATE TABLE teams (${STD},
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  lead        TEXT NOT NULL DEFAULT '' CHECK (length(lead) <= 120),
  description TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX teams_name_uq ON teams (lower(name)) WHERE deleted_at IS NULL;

-- Người dùng: quyền MCP (read / write / admin), token cá nhân (chỉ lưu băm), mật khẩu (băm scrypt)
CREATE TABLE users (${STD},
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  email            TEXT NOT NULL CHECK (length(email) <= 200),
  role             TEXT NOT NULL DEFAULT 'read' CHECK (role IN ('read', 'write', 'admin')),
  team_id          BIGINT REFERENCES teams (id_private),
  active           BOOLEAN NOT NULL DEFAULT true,
  token_hash       TEXT NOT NULL DEFAULT '',
  token_hint       TEXT NOT NULL DEFAULT '',
  token_created_at TIMESTAMPTZ,
  last_used_at     TIMESTAMPTZ,
  password_hash    TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX users_email_uq ON users (email) WHERE deleted_at IS NULL;
CREATE INDEX users_token_hash_idx ON users (token_hash) WHERE token_hash <> '' AND deleted_at IS NULL;

-- Phiên đăng nhập quản trị (cookie fb_admin / Bearer fbs_...), chỉ lưu băm của token phiên
CREATE TABLE sessions (${STD},
  user_id    BIGINT NOT NULL REFERENCES users (id_private),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- File tải lên (ảnh, HAR, tài liệu). storage_key = tên trong URL /uploads/<storage_key>.
-- storage = 'r2' (Cloudflare R2) hoặc 'db' (bytes nằm ở cột data).
CREATE TABLE files (${STD},
  storage_key   TEXT NOT NULL UNIQUE,
  storage       TEXT NOT NULL CHECK (storage IN ('db', 'r2')),
  mime          TEXT NOT NULL,
  size          BIGINT NOT NULL CHECK (size >= 0),
  original_name TEXT NOT NULL DEFAULT '',
  data          BYTEA
);

-- Dự án
CREATE TABLE projects (${STD},
  code                TEXT NOT NULL DEFAULT '' CHECK (length(code) <= 30),
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description         TEXT NOT NULL DEFAULT '',
  total_value         BIGINT NOT NULL DEFAULT 0 CHECK (total_value >= 0),
  start_date          DATE,
  deadline            DATE,
  invoice_feedback_id BIGINT, -- khóa ngoại tới feedbacks, thêm sau khi tạo bảng feedbacks
  CHECK (start_date IS NULL OR deadline IS NULL OR deadline >= start_date)
);
CREATE UNIQUE INDEX projects_name_uq ON projects (lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX projects_code_uq ON projects (code) WHERE code <> '' AND deleted_at IS NULL;

-- Nhân sự tham gia dự án (bảng nối)
CREATE TABLE project_members (${STD},
  project_id BIGINT NOT NULL REFERENCES projects (id_private),
  user_id    BIGINT NOT NULL REFERENCES users (id_private)
);
CREATE UNIQUE INDEX project_members_uq ON project_members (project_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX project_members_user_idx ON project_members (user_id);

-- Vai trò trong dự án (dùng làm "Loại" khi tạo backlog)
CREATE TABLE project_roles (${STD},
  project_id  BIGINT NOT NULL REFERENCES projects (id_private),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  sort_order  INT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX project_roles_name_uq ON project_roles (project_id, lower(name)) WHERE deleted_at IS NULL;

-- Backlog (lỗi / công việc). stt đánh số riêng theo dự án, không tái sử dụng (kể cả bản đã xóa).
CREATE TABLE feedbacks (${STD},
  project_id    BIGINT NOT NULL REFERENCES projects (id_private),
  team_id       BIGINT REFERENCES teams (id_private),
  assignee_id   BIGINT REFERENCES users (id_private),
  stt           INT NOT NULL CHECK (stt > 0),
  title         TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 200),
  type          TEXT NOT NULL DEFAULT '' CHECK (length(type) <= 60),
  status        TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
  location_url  TEXT NOT NULL DEFAULT '',
  bug_text      TEXT NOT NULL DEFAULT '',
  expected_text TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  completed_at  TIMESTAMPTZ,
  updated_by    TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX feedbacks_project_stt_uq ON feedbacks (project_id, stt);
CREATE INDEX feedbacks_team_idx ON feedbacks (team_id) WHERE deleted_at IS NULL;
CREATE INDEX feedbacks_assignee_idx ON feedbacks (assignee_id) WHERE deleted_at IS NULL;
ALTER TABLE projects ADD CONSTRAINT projects_invoice_feedback_fk FOREIGN KEY (invoice_feedback_id) REFERENCES feedbacks (id_private);

-- Tệp đính kèm của backlog: ảnh vị trí (location), ảnh mô tả lỗi (bug), ảnh kết quả mong muốn (expected), file HAR (har)
CREATE TABLE feedback_attachments (${STD},
  feedback_id BIGINT NOT NULL REFERENCES feedbacks (id_private),
  file_id     BIGINT NOT NULL REFERENCES files (id_private),
  kind        TEXT NOT NULL CHECK (kind IN ('location', 'bug', 'expected', 'har')),
  sort_order  INT NOT NULL DEFAULT 0
);
CREATE INDEX feedback_attachments_feedback_idx ON feedback_attachments (feedback_id) WHERE deleted_at IS NULL;

-- Đợt thanh toán của dự án
CREATE TABLE payment_rounds (${STD},
  project_id          BIGINT NOT NULL REFERENCES projects (id_private),
  stt                 INT NOT NULL CHECK (stt > 0),
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  amount              BIGINT NOT NULL CHECK (amount >= 0),
  note                TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  paid_at             DATE,
  paid                BOOLEAN NOT NULL DEFAULT false,
  company_account     BOOLEAN NOT NULL DEFAULT false,
  image_file_id       BIGINT REFERENCES files (id_private),
  invoice_feedback_id BIGINT REFERENCES feedbacks (id_private)
);
CREATE UNIQUE INDEX payment_rounds_project_stt_uq ON payment_rounds (project_id, stt);

-- Tài liệu PTYC (phân tích yêu cầu) của dự án; mỗi lần tải lên là một phiên bản
CREATE TABLE documents (${STD},
  project_id BIGINT NOT NULL REFERENCES projects (id_private),
  title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  doc_type   TEXT NOT NULL DEFAULT '' CHECK (length(doc_type) <= 60),
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'approved')),
  note       TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 2000)
);
CREATE INDEX documents_project_idx ON documents (project_id) WHERE deleted_at IS NULL;

CREATE TABLE document_versions (${STD},
  document_id BIGINT NOT NULL REFERENCES documents (id_private),
  file_id     BIGINT NOT NULL REFERENCES files (id_private),
  version     TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 30),
  note        TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  uploaded_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX document_versions_document_idx ON document_versions (document_id) WHERE deleted_at IS NULL;

-- Nhật ký thay đổi theo dự án (backlog, thanh toán, tài liệu)
CREATE TABLE activity_logs (${STD},
  project_id       BIGINT REFERENCES projects (id_private),
  entity_type      TEXT NOT NULL CHECK (entity_type IN ('backlog', 'payment', 'ptyc', 'project')),
  entity_public_id UUID,
  entity_title     TEXT NOT NULL DEFAULT '',
  action           TEXT NOT NULL CHECK (action IN ('created', 'updated', 'status', 'assigned', 'deleted')),
  actor            TEXT NOT NULL DEFAULT '',
  details          JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX activity_logs_project_idx ON activity_logs (project_id, created_at DESC) WHERE deleted_at IS NULL;

-- Nhật ký quản trị (đăng nhập, tạo / sửa người dùng, cấp token...)
CREATE TABLE audit_logs (${STD},
  actor  TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT ''
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);

${TABLES.map(touch).join('\n')}
`,
  },
];

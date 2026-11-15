# Kết nối MCP

Hướng dẫn cho dev dùng công cụ AI (Claude Code, Cursor, VS Code, Claude Desktop) đọc backlog trực tiếp từ hệ thống, xem lỗi, phân tích HAR, sửa code rồi cập nhật trạng thái. Nội dung tương ứng trang `/mcp-guide` của web app.

- **Endpoint (production):** `https://mvv-backlog-system.vercel.app/mcp`
- **Giao thức:** MCP qua Streamable HTTP (`POST /mcp`, JSON-RPC)
- **Xác thực:** token cá nhân, gửi qua header `Authorization: Bearer <TOKEN>`
- **Quyền:** theo vai trò của người dùng, xem mục [Quyền và tool](#quyền-và-tool)

> `/mcp` là endpoint JSON-RPC (được frontend proxy sang backend). Trang hướng dẫn nằm ở `/mcp-guide`.

## Bước 1. Lấy token cá nhân

1. Nhờ quản trị viên tạo tài khoản cho bạn ở trang **Người dùng** (`/users`) và chọn quyền: chỉ đọc, đọc + ghi, hoặc quản trị.
2. Quản trị viên bấm cấp token. Token có dạng `fbk_...` và **chỉ hiện một lần**, vì hệ thống chỉ lưu bản băm.
3. Mất token thì nhờ quản trị viên cấp lại. Token cũ mất hiệu lực ngay.

Tự tạo token cho admin đầu tiên (chạy trên máy có `DATABASE_URL`):

```bash
cd backend
npm run create-admin -- "Họ tên" email@congty.vn
```

Token là mật khẩu truy cập. Không dán vào chat, không commit vào git. Nếu lỡ lộ, cấp lại token ở trang Người dùng.

## Bước 2. Thêm vào công cụ của bạn

Thay `<TOKEN>` bằng token thật. Nên lưu token trong biến môi trường (ví dụ `BACKLOG_MCP_TOKEN`) thay vì ghi thẳng vào file cấu hình.

### Claude Code (CLI)

```bash
claude mcp add --transport http feedback-backlog https://mvv-backlog-system.vercel.app/mcp \
  --header "Authorization: Bearer <TOKEN>"
```

Phạm vi lưu:

| Tùy chọn | Ý nghĩa |
| --- | --- |
| mặc định (`--scope local`) | Chỉ máy bạn, chỉ project hiện tại |
| `--scope user` | Dùng ở mọi project trên máy bạn |
| `--scope project` | Ghi vào `.mcp.json` để chia sẻ cho team. Không đặt token thật vào file này |

### `.mcp.json` (Claude Code, dùng chung cả team)

Commit file này vào repo. Mỗi dev tự đặt biến môi trường `BACKLOG_MCP_TOKEN`:

```json
{
  "mcpServers": {
    "feedback-backlog": {
      "type": "http",
      "url": "https://mvv-backlog-system.vercel.app/mcp",
      "headers": {
        "Authorization": "Bearer ${BACKLOG_MCP_TOKEN}"
      }
    }
  }
}
```

Lưu ý: khóa gốc phải là `mcpServers` và giá trị header phải có tiền tố `Bearer `.

### Cursor

Thêm vào `~/.cursor/mcp.json` (toàn cục) hoặc `.cursor/mcp.json` (theo project), rồi bật server trong **Settings → MCP**:

```json
{
  "mcpServers": {
    "feedback-backlog": {
      "url": "https://mvv-backlog-system.vercel.app/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" }
    }
  }
}
```

### VS Code

Cần GitHub Copilot Chat, chế độ Agent. Tạo `.vscode/mcp.json` trong project (khóa gốc ở đây là `servers`, khác với các công cụ khác):

```json
{
  "servers": {
    "feedback-backlog": {
      "type": "http",
      "url": "https://mvv-backlog-system.vercel.app/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" }
    }
  }
}
```

### Claude Desktop

Claude Desktop chưa nối trực tiếp tới HTTP bằng file cấu hình, nên dùng cầu nối `mcp-remote` (cần Node.js). Thêm vào `claude_desktop_config.json` rồi khởi động lại app:

```json
{
  "mcpServers": {
    "feedback-backlog": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://mvv-backlog-system.vercel.app/mcp",
        "--header", "Authorization: Bearer <TOKEN>"
      ]
    }
  }
}
```

## Bước 3. Kiểm tra kết nối

Trong Claude Code gõ `/mcp`, hoặc chạy:

```bash
claude mcp list
```

`feedback-backlog` phải ở trạng thái connected. Cũng có thể kiểm tra bằng curl:

```bash
curl -s https://mvv-backlog-system.vercel.app/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Kết quả trả về danh sách tool là thành công.

| Lỗi | Nguyên nhân |
| --- | --- |
| `401` | Thiếu hoặc sai token (thiếu `Bearer `, copy thiếu ký tự) |
| `403` | Tài khoản bị vô hiệu hóa |
| `429` | Quá giới hạn request, hoặc IP bị khóa 15 phút do sai token quá nhiều lần |
| `ECONNREFUSED` | URL sai hoặc server không chạy (hay gặp khi cấu hình còn trỏ vào `localhost`) |

## Quyền và tool

| Tool | Chức năng | Loại |
| --- | --- | --- |
| `list_projects` | Danh sách dự án kèm số backlog theo trạng thái | Đọc |
| `list_teams` | Danh sách team xử lý kèm số việc đang mở | Đọc |
| `list_backlog` | Liệt kê backlog, lọc theo dự án, team, trạng thái, từ khóa | Đọc |
| `get_backlog` | Chi tiết một backlog: mô tả, kết quả mong muốn, URL, ảnh, HAR | Đọc |
| `analyze_har` | Phân tích HAR: request lỗi 4xx/5xx, request chậm, body request và response | Đọc |
| `update_backlog_status` | Đổi trạng thái: chưa làm, đang làm, đã hoàn thành | Ghi |
| `assign_backlog_team` | Giao backlog cho team | Ghi |

Tài khoản vai trò **Chỉ đọc** không dùng được 2 tool ghi. Nếu server bật `MCP_READONLY=1` thì toàn bộ người dùng chỉ đọc.

## Prompt mẫu

- Liệt kê các backlog chưa làm của team kỹ thuật.
- Xem backlog #3 dự án demo (kèm ảnh), tìm nguyên nhân trong code và sửa. Bắt đầu thì chuyển sang "đang làm", sửa xong chuyển "đã hoàn thành".
- Backlog #5 dự án demo có file HAR, phân tích xem API nào lỗi rồi đề xuất cách sửa.

## Dành cho quản trị viên (cấu hình server)

| Biến / lệnh | Ý nghĩa |
| --- | --- |
| `npm run create-admin -- "Họ tên" email [mật-khẩu]` | Tạo admin đầu tiên hoặc cấp lại token cho admin bị mất. Cần quyền truy cập `DATABASE_URL` |
| `MCP_READONLY=1` | Ép toàn server chỉ đọc, bất kể quyền từng người |
| `PUBLIC_URL` | Địa chỉ công khai của web app, dùng dựng link ảnh và HAR. Bỏ trống thì lấy theo request |
| `TRUST_PROXY` | Số proxy phía trước app (mặc định 1). Không có proxy thì đặt 0 để IP không bị giả mạo qua `X-Forwarded-For` |
| `DEV_NO_AUTH=1` | Chỉ dùng khi chạy local, bỏ xác thực. Không bật khi deploy |

Chạy sau nginx hoặc load balancer: bật HTTPS, chuyển tiếp header `Host` và `X-Forwarded-Proto`, đặt `proxy_buffering off;` cho location `/mcp`.

Bảo vệ sẵn có:

- 60 request/phút/IP và 300 request/phút toàn server.
- Sai token quá 8 lần thì khóa IP 15 phút.
- Tối đa 8 request MCP chạy đồng thời, timeout 60 giây.
- Giới hạn khi đọc: HAR 20MB, ảnh 5MB/ảnh.
- Token lưu dạng băm, không xem lại được.

Token cá nhân chỉ bảo vệ endpoint `/mcp`. Các API `/api/*` của web app hiện chưa có đăng nhập, nên cân nhắc đặt web app sau VPN hoặc SSO.

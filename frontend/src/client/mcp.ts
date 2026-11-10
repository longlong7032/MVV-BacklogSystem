/**
 * Trang hướng dẫn MCP: chuyển tab cấu hình (Claude Code, Cursor, VS Code, Claude Desktop).
 * Nội dung của mọi tab đã được server render sẵn; ở đây chỉ ẩn / hiện.
 */
import { $$, closest, data } from './dom.js';

/** Gắn hành vi chuyển tab MCP. */
export function initMcp(): void {
  const tabs = $$('[data-mcp-tab]');
  if (!tabs.length) return;
  document.addEventListener('click', (e) => {
    const tab = closest(e, '[data-mcp-tab]');
    if (!tab) return;
    const key = data(tab, 'mcpTab');
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    $$('[data-mcp-hint]').forEach((p) => p.classList.toggle('hidden', data(p, 'mcpHint') !== key));
    $$('[data-mcp-code]').forEach((p) => p.classList.toggle('hidden', data(p, 'mcpCode') !== key));
  });
}

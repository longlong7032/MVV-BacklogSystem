/**
 * Trang DevTools ẩn của extension.
 *
 * Chạy ngầm khi DevTools đang mở cho một tab: cho phép popup lấy HAR đầy đủ (kèm response body),
 * giống "Export HAR" trong tab Network. Popup gửi tin nhắn `devtools:getHar`, trang này dựng HAR và trả lời.
 */
import type { Har, HarEntry } from './types.js';

/** Request đã kết thúc do DevTools báo, có thêm `getContent` để lấy response body. */
type FinishedRequest = chrome.devtools.network.Request;

/** Tin nhắn từ popup yêu cầu xuất HAR. */
interface GetHarMessage {
  type: string;
  tabId: number;
}

/** Id của tab mà DevTools này đang kiểm tra. */
const tabId = chrome.devtools.inspectedWindow.tabId;
const MAX_BODY = 1024 * 1024; // tối đa 1MB mỗi response body
/** Loại nội dung nhị phân không lấy body (ảnh, font, âm thanh, video) để HAR nhẹ. */
const SKIP_BODY = /^(image|font|audio|video)\//i;
/** Các request đã xong (có getContent), giữ lại để bổ sung những request getHAR không còn trả về. */
const finished: FinishedRequest[] = [];
const MAX_FINISHED = 1500;

chrome.devtools.network.onRequestFinished.addListener((request) => {
  finished.push(request);
  if (finished.length > MAX_FINISHED) finished.splice(0, finished.length - MAX_FINISHED);
});

// Báo cho background biết DevTools đang mở cho tab này (đóng DevTools thì port tự ngắt).
const port = chrome.runtime.connect({ name: 'devtools:' + tabId });
port.onDisconnect.addListener(() => {});

/** Lấy HAR hiện tại mà DevTools đang giữ (chưa có response body). */
const getHar = (): Promise<{ entries: HarEntry[]; [key: string]: unknown }> =>
  new Promise((resolve) => chrome.devtools.network.getHAR((log) => resolve(log as unknown as { entries: HarEntry[] })));

/** Lấy response body của một request; quá 3 giây hoặc lỗi thì trả [null, null]. */
const getContent = (request: FinishedRequest): Promise<[string | null, string | null]> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve([null, null]), 3000);
    request.getContent((content, encoding) => {
      clearTimeout(timer);
      resolve([content, encoding]);
    });
  });

/** Khóa nhận diện một entry (thời điểm bắt đầu + method + URL) để ghép HAR với request đã ghi. */
const keyOf = (entry: { startedDateTime: string; request: { method: string; url: string } }): string =>
  entry.startedDateTime + '|' + entry.request.method + '|' + entry.request.url;

/**
 * Dựng HAR đầy đủ:
 *  1. lấy HAR từ DevTools;
 *  2. bổ sung các request đã ghi nhận nhưng getHAR không còn trả về (ví dụ sau khi chuyển trang);
 *  3. gắn response body cho từng entry (bỏ qua ảnh/font/media, cắt body quá lớn).
 */
async function exportHar(): Promise<Har> {
  const log = await getHar();
  const byKey = new Map(finished.map((r) => [keyOf(r as unknown as HarEntry), r]));

  const seen = new Set(log.entries.map(keyOf));
  const extra = finished.filter((r) => !seen.has(keyOf(r as unknown as HarEntry))).map((r) => JSON.parse(JSON.stringify(r)) as HarEntry);
  const entries = [...extra, ...log.entries].sort((a, b) => a.startedDateTime.localeCompare(b.startedDateTime));

  await Promise.all(
    entries.map(async (entry) => {
      const source = byKey.get(keyOf(entry));
      const content = entry.response.content || (entry.response.content = { size: 0, mimeType: '' });
      if (!source || SKIP_BODY.test(content.mimeType || '')) return;
      const [text, encoding] = await getContent(source);
      if (text == null) return;
      if (text.length > MAX_BODY) {
        content.comment = `Body bị cắt (${text.length} ký tự)`;
        return;
      }
      content.text = text;
      if (encoding) content.encoding = encoding;
    })
  );

  return { log: { ...log, entries } };
}

// Popup hỏi HAR: chỉ trả lời nếu tin nhắn dành cho tab mà DevTools này đang kiểm tra
chrome.runtime.onMessage.addListener((msg: GetHarMessage | undefined, _sender, sendResponse) => {
  if (msg && msg.type === 'devtools:getHar' && msg.tabId === tabId) {
    exportHar().then(
      (har) => sendResponse({ har }),
      (err: unknown) => sendResponse({ error: String(err instanceof Error ? err.message : err) })
    );
    return true; // phản hồi bất đồng bộ
  }
  return false;
});

/**
 * Service worker của extension.
 *
 * Ghi nền log mạng của từng tab (qua chrome.webRequest) để khi gặp lỗi có thể xuất HAR ngay,
 * kể cả khi DevTools chưa mở. Không lấy được response body (giới hạn của webRequest).
 * Service worker MV3 có thể bị tắt khi rảnh -> log được lưu vào chrome.storage.session.
 *
 * Giao tiếp với popup qua tin nhắn:
 *  - `bg:status`  -> { devtools, count }   trạng thái ghi log của tab
 *  - `bg:getHar`  -> { har }               HAR dựng từ log ghi nền
 *  - `bg:clear`   -> { ok }                xóa log của tab
 */
import type { Har, HarEntry, HarHeader } from '../../shared/types.js';

/* ---------- Kiểu dữ liệu ---------- */

/** Body của request do webRequest cung cấp (formData đã tách sẵn hoặc raw byte). */
type RequestBody = NonNullable<chrome.webRequest.OnBeforeRequestDetails['requestBody']>;

/** postData của request trong HAR. */
interface PostData {
  mimeType: string;
  text: string;
  params?: Array<{ name: string; value: string }>;
}

/** Request đang diễn ra (chưa kết thúc) — được gom dần qua các sự kiện webRequest. */
interface PendingRequest {
  url: string;
  method: string;
  type: string;
  /** Thời điểm bắt đầu (ms từ epoch). */
  start: number;
  /** Body thô từ onBeforeRequest; được chuyển thành `postData` ở onSendHeaders rồi xóa. */
  body?: RequestBody;
  requestHeaders?: chrome.webRequest.HttpHeader[];
  responseHeaders?: chrome.webRequest.HttpHeader[];
  postData?: PostData;
}

/** Log mạng của một tab. */
interface TabLog {
  /** Các request đã hoàn tất, theo thứ tự thời gian. */
  entries: HarEntry[];
  /** Các request đang diễn ra, khóa = requestId. */
  pending: Record<string, PendingRequest>;
}

/** Tin nhắn popup gửi tới background. */
interface BgMessage {
  type: string;
  tabId: number;
}

/** Chi tiết sự kiện kết thúc request (hoàn tất / chuyển hướng / lỗi) mà `finish` dùng. */
type FinishDetails = {
  tabId: number;
  requestId: string;
  timeStamp: number;
  ip?: string;
  statusCode?: number;
  statusLine?: string;
  fromCache?: boolean;
  redirectUrl?: string;
};

/* ---------- Hằng số & trạng thái ---------- */

const MAX_ENTRIES = 300; // số request tối đa lưu cho mỗi tab
const MAX_BODY = 64 * 1024; // request body tối đa 64KB
const SAVE_DELAY = 400; // gom các lần ghi storage trong 400ms
const FILTER: chrome.webRequest.RequestFilter = { urls: ['<all_urls>'] };

/** Log của từng tab, khóa = tabId. */
const tabs = new Map<number, TabLog>();
/** Các tab đang mở DevTools (có kết nối từ devtools.ts). */
const devtoolsTabs = new Set<number>();
/** Các tab có thay đổi chưa được lưu vào storage. */
const dirty = new Set<number>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Khóa lưu log của tab trong chrome.storage.session. */
const key = (tabId: number): string => 'net:' + tabId;

/** Nạp lại log đã lưu khi service worker khởi động lại; mọi xử lý phải chờ `ready`. */
const ready: Promise<void> = chrome.storage.session.get(null).then((all) => {
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('net:')) tabs.set(Number(k.slice(4)), v as TabLog);
  }
});

/** Lấy log của tab, tạo mới nếu chưa có. */
function tabLog(tabId: number): TabLog {
  let log = tabs.get(tabId);
  if (!log) tabs.set(tabId, (log = { entries: [], pending: {} }));
  return log;
}

/** Đặt lịch lưu log của tab (gom nhiều thay đổi liên tiếp thành một lần ghi). */
function scheduleSave(tabId: number): void {
  dirty.add(tabId);
  if (saveTimer) return;
  saveTimer = setTimeout(flush, SAVE_DELAY);
}

/** Ghi các log đã thay đổi vào chrome.storage.session; hết quota thì bỏ bớt một nửa log cũ rồi thử lại. */
async function flush(): Promise<void> {
  saveTimer = null;
  const data: Record<string, TabLog> = {};
  for (const id of dirty) {
    const log = tabs.get(id);
    if (log) data[key(id)] = log;
  }
  dirty.clear();
  try {
    await chrome.storage.session.set(data);
  } catch {
    // Hết quota -> bỏ bớt một nửa log cũ của mọi tab rồi thử lại.
    for (const [id, log] of tabs) {
      log.entries = log.entries.slice(Math.floor(log.entries.length / 2));
      data[key(id)] = log;
    }
    chrome.storage.session.set(data).catch(() => {});
  }
}

/* ---------- Chuyển dữ liệu webRequest sang HAR ---------- */

/** Chuẩn hóa danh sách header của webRequest sang định dạng HAR (value luôn là chuỗi). */
const toHeaders = (list: chrome.webRequest.HttpHeader[] | undefined): HarHeader[] =>
  (list || []).map((h) => ({ name: h.name, value: h.value ?? '' }));

/** Tách query string của URL thành danh sách { name, value }; URL sai -> rỗng. */
function toQuery(url: string): Array<{ name: string; value: string }> {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

/**
 * Dựng `postData` của HAR từ body thô của webRequest.
 * Body quá lớn (> MAX_BODY) hoặc không có dữ liệu thì không ghi nội dung.
 */
function toPostData(body: RequestBody | undefined, headers: chrome.webRequest.HttpHeader[] | undefined): PostData | undefined {
  if (!body) return undefined;
  const mimeType = (headers || []).find((h) => /^content-type$/i.test(h.name))?.value || '';
  // Form: webRequest đã tách sẵn các cặp name=value
  if (body.formData) {
    const params = Object.entries(body.formData).flatMap(([name, values]) => values.map((value) => ({ name, value: String(value) })));
    return { mimeType: mimeType || 'application/x-www-form-urlencoded', params, text: '' };
  }
  // Raw: ghép các mảnh byte lại rồi giải mã UTF-8
  if (body.raw) {
    const bytes = body.raw.filter((r) => r.bytes).map((r) => new Uint8Array(r.bytes as ArrayBuffer));
    const size = bytes.reduce((n, b) => n + b.length, 0);
    if (!size) return undefined;
    if (size > MAX_BODY) return { mimeType, text: `[Body ${size} bytes – quá lớn, không ghi lại]` };
    const all = new Uint8Array(size);
    let offset = 0;
    for (const b of bytes) {
      all.set(b, offset);
      offset += b.length;
    }
    return { mimeType, text: new TextDecoder().decode(all) };
  }
  return undefined;
}

/**
 * Chốt một request đang diễn ra thành một entry HAR rồi thêm vào log của tab.
 * @param details thông tin sự kiện kết thúc (hoàn tất, chuyển hướng hoặc lỗi)
 * @param extra `{ error }` nếu request thất bại ở tầng mạng
 */
function finish(details: FinishDetails, extra: { error?: string }): void {
  const log = tabs.get(details.tabId);
  const p = log && log.pending[details.requestId];
  if (!log || !p) return;
  delete log.pending[details.requestId];

  const responseHeaders = p.responseHeaders || [];
  const mimeType = responseHeaders.find((h) => /^content-type$/i.test(h.name))?.value || '';
  const time = Math.max(0, Math.round(details.timeStamp - p.start));
  const isError = Boolean(extra.error);

  log.entries.push({
    startedDateTime: new Date(p.start).toISOString(),
    time,
    _resourceType: p.type,
    ...(details.ip ? { serverIPAddress: details.ip } : {}),
    request: {
      method: p.method,
      url: p.url,
      httpVersion: 'HTTP/1.1',
      headers: toHeaders(p.requestHeaders),
      queryString: toQuery(p.url),
      cookies: [],
      headersSize: -1,
      bodySize: p.postData && p.postData.text ? p.postData.text.length : 0,
      ...(p.postData ? { postData: p.postData } : {}),
    },
    response: {
      status: isError ? 0 : details.statusCode || 0,
      statusText: isError ? (extra.error as string) : (details.statusLine || '').replace(/^\S+\s+\d+\s*/, ''),
      httpVersion: (details.statusLine || '').split(' ')[0] || 'HTTP/1.1',
      headers: toHeaders(responseHeaders),
      cookies: [],
      content: { size: -1, mimeType },
      redirectURL: details.redirectUrl || '',
      headersSize: -1,
      bodySize: -1,
      ...(details.fromCache ? { _fromCache: true } : {}),
      ...(isError ? { _error: extra.error } : {}),
    },
    cache: {},
    timings: { send: 0, wait: time, receive: 0 },
  });
  if (log.entries.length > MAX_ENTRIES) log.entries.splice(0, log.entries.length - MAX_ENTRIES);
  scheduleSave(details.tabId);
}

/* ---------- Listeners webRequest ---------- */

/**
 * Bọc handler: bỏ qua request không thuộc tab nào (extension / service worker, tabId < 0)
 * và chờ log được nạp xong từ storage trước khi xử lý.
 */
const onTab =
  <D extends { tabId: number }>(fn: (details: D) => void) =>
  (details: D): undefined => {
    if (details.tabId < 0) return undefined;
    ready.then(() => fn(details));
    return undefined; // không chặn / sửa request, chỉ quan sát
  };

// 1) Bắt đầu request: tạo bản ghi "đang diễn ra" kèm body thô
chrome.webRequest.onBeforeRequest.addListener(
  onTab<chrome.webRequest.OnBeforeRequestDetails>((d) => {
    tabLog(d.tabId).pending[d.requestId] = {
      url: d.url,
      method: d.method,
      type: d.type,
      start: d.timeStamp,
      body: d.requestBody,
    };
  }),
  FILTER,
  ['requestBody']
);

// 2) Gửi header: có header rồi mới dựng được postData (cần Content-Type)
chrome.webRequest.onSendHeaders.addListener(
  onTab<chrome.webRequest.OnSendHeadersDetails>((d) => {
    const p = tabs.get(d.tabId)?.pending[d.requestId];
    if (!p) return;
    p.requestHeaders = d.requestHeaders;
    p.postData = toPostData(p.body, d.requestHeaders);
    delete p.body;
  }),
  FILTER,
  ['requestHeaders', 'extraHeaders']
);

// 3) Nhận header phản hồi
chrome.webRequest.onHeadersReceived.addListener(
  onTab<chrome.webRequest.OnHeadersReceivedDetails>((d) => {
    const p = tabs.get(d.tabId)?.pending[d.requestId];
    if (p) p.responseHeaders = d.responseHeaders;
  }),
  FILTER,
  ['responseHeaders', 'extraHeaders']
);

// 4) Kết thúc: redirect chốt entry hiện tại (request tiếp theo cùng requestId sẽ bắt đầu lại ở onBeforeRequest)
chrome.webRequest.onBeforeRedirect.addListener(
  onTab<chrome.webRequest.OnBeforeRedirectDetails>((d) => finish(d, {})),
  FILTER
);
chrome.webRequest.onCompleted.addListener(
  onTab<chrome.webRequest.OnCompletedDetails>((d) => finish(d, {})),
  FILTER
);
chrome.webRequest.onErrorOccurred.addListener(
  onTab<chrome.webRequest.OnErrorOccurredDetails>((d) => finish(d, { error: d.error })),
  FILTER
);

// Đóng tab -> xóa log và bản nháp của tab đó
chrome.tabs.onRemoved.addListener((tabId) => {
  ready.then(() => {
    tabs.delete(tabId);
    chrome.storage.session.remove(key(tabId));
    chrome.storage.session.remove('draft:' + tabId);
  });
});

/* ---------- DevTools đang mở cho tab nào ---------- */

// devtools.ts mở một port tên "devtools:<tabId>" khi DevTools mở và đóng nó khi DevTools tắt
chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('devtools:')) return;
  const tabId = Number(port.name.slice(9));
  devtoolsTabs.add(tabId);
  port.onDisconnect.addListener(() => devtoolsTabs.delete(tabId));
});

/* ---------- Tin nhắn từ popup ---------- */

chrome.runtime.onMessage.addListener((msg: BgMessage | undefined, _sender, sendResponse) => {
  // Chỉ xử lý tin nhắn "bg:*"; các loại khác (vd "devtools:getHar") thuộc về nơi khác
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('bg:')) return false;

  ready.then(() => {
    const log = tabs.get(msg.tabId) || { entries: [], pending: {} };
    if (msg.type === 'bg:status') {
      sendResponse({ devtools: devtoolsTabs.has(msg.tabId), count: log.entries.length });
    } else if (msg.type === 'bg:getHar') {
      const version = chrome.runtime.getManifest().version;
      const har: Har = {
        log: {
          version: '1.2',
          creator: { name: 'Feedback backlog extension', version },
          comment: 'Ghi bằng chrome.webRequest: có header, status, thời gian; không có response body.',
          pages: [],
          entries: log.entries,
        },
      };
      sendResponse({ har });
    } else if (msg.type === 'bg:clear') {
      tabs.set(msg.tabId, { entries: [], pending: {} });
      scheduleSave(msg.tabId);
      sendResponse({ ok: true });
    }
  });
  return true; // phản hồi bất đồng bộ
});

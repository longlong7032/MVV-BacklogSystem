// Ghi nền log mạng của từng tab (qua webRequest) để khi gặp lỗi có thể xuất HAR ngay,
// kể cả khi DevTools chưa mở. Không lấy được response body (giới hạn của webRequest).
// Service worker MV3 có thể bị tắt khi rảnh -> lưu log vào chrome.storage.session.

const MAX_ENTRIES = 300; // mỗi tab
const MAX_BODY = 64 * 1024; // request body tối đa 64KB
const SAVE_DELAY = 400;
const FILTER = { urls: ['<all_urls>'] };

const tabs = new Map(); // tabId -> { entries: [], pending: {} }
const devtoolsTabs = new Set();
const dirty = new Set();
let saveTimer = null;

const key = (tabId) => 'net:' + tabId;

const ready = chrome.storage.session.get(null).then((all) => {
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('net:')) tabs.set(Number(k.slice(4)), v);
  }
});

function tabLog(tabId) {
  let log = tabs.get(tabId);
  if (!log) tabs.set(tabId, (log = { entries: [], pending: {} }));
  return log;
}

function scheduleSave(tabId) {
  dirty.add(tabId);
  if (saveTimer) return;
  saveTimer = setTimeout(flush, SAVE_DELAY);
}

async function flush() {
  saveTimer = null;
  const data = {};
  for (const id of dirty) if (tabs.has(id)) data[key(id)] = tabs.get(id);
  dirty.clear();
  try {
    await chrome.storage.session.set(data);
  } catch (e) {
    // Hết quota -> bỏ bớt một nửa log cũ của mọi tab rồi thử lại.
    for (const [id, log] of tabs) {
      log.entries = log.entries.slice(Math.floor(log.entries.length / 2));
      data[key(id)] = log;
    }
    chrome.storage.session.set(data).catch(() => {});
  }
}

/* ---------- Chuyển dữ liệu webRequest sang HAR ---------- */
const toHeaders = (list) => (list || []).map((h) => ({ name: h.name, value: h.value ?? '' }));

function toQuery(url) {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch (e) {
    return [];
  }
}

function toPostData(body, headers) {
  if (!body) return undefined;
  const mimeType = (headers || []).find((h) => /^content-type$/i.test(h.name))?.value || '';
  if (body.formData) {
    const params = Object.entries(body.formData).flatMap(([name, values]) => values.map((value) => ({ name, value })));
    return { mimeType: mimeType || 'application/x-www-form-urlencoded', params, text: '' };
  }
  if (body.raw) {
    const bytes = body.raw.filter((r) => r.bytes).map((r) => new Uint8Array(r.bytes));
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

function finish(details, extra) {
  const log = tabs.get(details.tabId);
  const p = log && log.pending[details.requestId];
  if (!p) return;
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
      statusText: isError ? extra.error : (details.statusLine || '').replace(/^\S+\s+\d+\s*/, ''),
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

/* ---------- Listeners ---------- */
const onTab = (fn) => (details) => {
  if (details.tabId < 0) return; // request của extension / service worker
  ready.then(() => fn(details));
};

chrome.webRequest.onBeforeRequest.addListener(
  onTab((d) => {
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

chrome.webRequest.onSendHeaders.addListener(
  onTab((d) => {
    const p = tabs.get(d.tabId)?.pending[d.requestId];
    if (!p) return;
    p.requestHeaders = d.requestHeaders;
    p.postData = toPostData(p.body, d.requestHeaders);
    delete p.body;
  }),
  FILTER,
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  onTab((d) => {
    const p = tabs.get(d.tabId)?.pending[d.requestId];
    if (p) p.responseHeaders = d.responseHeaders;
  }),
  FILTER,
  ['responseHeaders', 'extraHeaders']
);

// Redirect: chốt entry hiện tại, request tiếp theo cùng requestId sẽ bắt đầu lại ở onBeforeRequest.
chrome.webRequest.onBeforeRedirect.addListener(onTab((d) => finish(d, {})), FILTER);
chrome.webRequest.onCompleted.addListener(onTab((d) => finish(d, {})), FILTER);
chrome.webRequest.onErrorOccurred.addListener(onTab((d) => finish(d, { error: d.error })), FILTER);

chrome.tabs.onRemoved.addListener((tabId) => {
  ready.then(() => {
    tabs.delete(tabId);
    chrome.storage.session.remove(key(tabId));
    chrome.storage.session.remove('draft:' + tabId);
  });
});

/* ---------- DevTools đang mở cho tab nào ---------- */
chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('devtools:')) return;
  const tabId = Number(port.name.slice(9));
  devtoolsTabs.add(tabId);
  port.onDisconnect.addListener(() => devtoolsTabs.delete(tabId));
});

/* ---------- Tin nhắn từ popup ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('bg:')) return false;

  ready.then(() => {
    const log = tabs.get(msg.tabId) || { entries: [], pending: {} };
    if (msg.type === 'bg:status') {
      sendResponse({ devtools: devtoolsTabs.has(msg.tabId), count: log.entries.length });
    } else if (msg.type === 'bg:getHar') {
      const version = chrome.runtime.getManifest().version;
      sendResponse({
        har: {
          log: {
            version: '1.2',
            creator: { name: 'Feedback backlog extension', version },
            comment: 'Ghi bằng chrome.webRequest: có header, status, thời gian; không có response body.',
            pages: [],
            entries: log.entries,
          },
        },
      });
    } else if (msg.type === 'bg:clear') {
      tabs.set(msg.tabId, { entries: [], pending: {} });
      scheduleSave(msg.tabId);
      sendResponse({ ok: true });
    }
  });
  return true;
});

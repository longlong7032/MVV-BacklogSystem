// Chạy ẩn khi DevTools đang mở cho một tab: cho phép popup lấy HAR đầy đủ (kèm response body),
// giống "Export HAR" trong tab Network.
const tabId = chrome.devtools.inspectedWindow.tabId;
const MAX_BODY = 1024 * 1024; // tối đa 1MB mỗi response body
const SKIP_BODY = /^(image|font|audio|video)\//i;
const finished = []; // các request đã xong (có getContent)
const MAX_FINISHED = 1500;

chrome.devtools.network.onRequestFinished.addListener((request) => {
  finished.push(request);
  if (finished.length > MAX_FINISHED) finished.splice(0, finished.length - MAX_FINISHED);
});

// Báo cho background biết DevTools đang mở cho tab này.
const port = chrome.runtime.connect({ name: 'devtools:' + tabId });
port.onDisconnect.addListener(() => {});

const getHar = () => new Promise((resolve) => chrome.devtools.network.getHAR(resolve));

const getContent = (request) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve([null, null]), 3000);
    request.getContent((content, encoding) => {
      clearTimeout(timer);
      resolve([content, encoding]);
    });
  });

const keyOf = (entry) => entry.startedDateTime + '|' + entry.request.method + '|' + entry.request.url;

async function exportHar() {
  const log = await getHar();
  const byKey = new Map(finished.map((r) => [keyOf(r), r]));

  // Bổ sung các request đã ghi nhận nhưng getHAR không còn trả về (ví dụ sau khi chuyển trang).
  const seen = new Set(log.entries.map(keyOf));
  const extra = finished.filter((r) => !seen.has(keyOf(r))).map((r) => JSON.parse(JSON.stringify(r)));
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'devtools:getHar' && msg.tabId === tabId) {
    exportHar().then(
      (har) => sendResponse({ har }),
      (err) => sendResponse({ error: String(err && err.message ? err.message : err) })
    );
    return true;
  }
  return false;
});

/**
 * Popup của extension: form báo lỗi nhanh.
 *
 * Luồng chính: mở popup -> chụp màn hình tab hiện tại -> người dùng mô tả lỗi, chọn dự án
 * -> (tuỳ chọn) lấy file HAR từ background/devtools -> gửi `POST /api/feedbacks` tới server backlog.
 * Biên dịch từ chrome-extension/src/popup.ts ra chrome-extension/popup.js (`npm run build:extension`).
 */
import type { Feedback, Har, HarHeader, Project } from './types.js';

/* ---------- Kiểu dữ liệu ---------- */

/** Trạng thái ghi log mạng mà background báo về cho popup. */
interface HarStatus {
  /** DevTools đang mở cho tab (HAR đầy đủ, có response body). */
  devtools: boolean;
  /** Số request đã ghi nhận nền. */
  count: number;
}

/** Bản nháp form lưu trong chrome.storage.session (popup tự đóng khi bấm ra ngoài). */
type Draft = Record<string, string> & { pageUrl?: string };

/** Trạng thái của popup. */
interface PopupState {
  tab: chrome.tabs.Tab | null;
  /** Địa chỉ server backlog (không có dấu / cuối). */
  server: string;
  /** Ảnh chụp màn hình của tab. */
  screenshot: Blob | null;
  /** Ảnh người dùng tự thêm. */
  images: File[];
  harStatus: HarStatus;
}

/** Tìm phần tử theo id và ép kiểu; ném lỗi nếu popup.html thiếu phần tử. */
function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Không tìm thấy phần tử #${id}`);
  return el as T;
}

/** Ô nhập liệu của form (input, textarea hoặc select). */
type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
/** Server backlog mặc định khi người dùng chưa cấu hình. */
const DEFAULT_SERVER = 'https://mvv-backlog.vercel.app/';
/** Số ảnh tối đa mỗi backlog (tính cả ảnh chụp màn hình). */
const MAX_IMAGES = 10;
/** Loại ảnh server chấp nhận. */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Header chứa thông tin xác thực — được che khi bật "ẩn dữ liệu nhạy cảm". */
const SENSITIVE_HEADERS =
  /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token)$/i;

const state: PopupState = {
  tab: null,
  server: DEFAULT_SERVER,
  screenshot: null,
  images: [],
  harStatus: { devtools: false, count: 0 },
};

/* ---------- Helpers ---------- */
/** Chuẩn hóa địa chỉ server: cắt khoảng trắng và dấu / cuối; rỗng -> mặc định. */
const normalizeServer = (url: string | undefined): string => (url || '').trim().replace(/\/+$/, '') || DEFAULT_SERVER;

/** Hiện (hoặc ẩn nếu rỗng) thông báo lỗi. */
function showError(message?: string): void {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}

/** Hiện (hoặc ẩn nếu rỗng) thông báo thành công; nhận HTML đã được escape. */
function showSuccess(html?: string): void {
  $('success').innerHTML = html || '';
  $('success').hidden = !html;
}

/** Escape HTML trước khi chèn vào innerHTML. */
const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** Gọi API của server backlog; ném `Error` có thông điệp tiếng Việt khi không kết nối được hoặc server báo lỗi. */
async function api<T = any>(path: string, options?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(state.server + path, options);
  } catch (e) {
    throw new Error(`Không kết nối được ${state.server}. Kiểm tra server đang chạy hoặc sửa địa chỉ trong "Cài đặt".`);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data as T;
}

/** Dấu thời gian dạng yyyymmdd-hhmmss dùng đặt tên file. */
const stamp = (): string => {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Tên host của URL (dùng đặt tên file HAR); lỗi -> "page". */
const hostOf = (url: string | undefined): string => {
  try {
    return new URL(url ?? '').hostname || 'page';
  } catch {
    return 'page';
  }
};

/* ---------- Bản nháp (popup tự đóng khi bấm ra ngoài) ---------- */
/** Các ô được lưu vào bản nháp. */
const DRAFT_FIELDS = ['project', 'locationUrl', 'bugText', 'expectedText'];
/** Khóa lưu bản nháp theo tab. */
const draftKey = (): string => 'draft:' + state.tab?.id;

/** Lưu nội dung đang nhập để không mất khi popup tự đóng. */
function saveDraft(): void {
  const draft: Draft = Object.fromEntries(DRAFT_FIELDS.map((id) => [id, $<Field>(id).value]));
  draft.pageUrl = state.tab?.url;
  chrome.storage.session.set({ [draftKey()]: draft });
}

/** Khôi phục bản nháp của tab hiện tại (nếu có) và trả về nó. */
async function loadDraft(): Promise<Draft | null> {
  const draft = (await chrome.storage.session.get(draftKey()))[draftKey()] as Draft | undefined;
  if (!draft) return null;
  // URL vị trí chỉ khôi phục khi tab vẫn ở đúng trang lúc viết nháp.
  const fields = draft.pageUrl === state.tab?.url ? ['locationUrl', 'bugText', 'expectedText'] : ['bugText', 'expectedText'];
  for (const id of fields) if (draft[id] != null) $<Field>(id).value = draft[id];
  return draft;
}

/** Xóa bản nháp sau khi gửi thành công. */
const clearDraft = (): Promise<void> => chrome.storage.session.remove(draftKey());

/* ---------- Dự án ---------- */
/** Nạp danh sách dự án từ server vào dropdown; chọn sẵn dự án dùng lần trước (hoặc dự án duy nhất). */
async function loadProjects(selectedId?: string): Promise<void> {
  const select = $<HTMLSelectElement>('project');
  try {
    const projects = await api<Project[]>('/api/projects');
    projects.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    select.innerHTML =
      `<option value="">— Chọn dự án —</option>` + projects.map((p) => `<option value="${esc(p.idPublic)}">${esc(p.name)}</option>`).join('');
    if (!projects.length) select.innerHTML = `<option value="">Chưa có dự án – tạo trong trang backlog</option>`;
    const wanted =
      selectedId && projects.some((p) => p.idPublic === selectedId) ? selectedId : projects.length === 1 ? (projects[0]?.idPublic ?? '') : '';
    select.value = wanted;
    showError('');
  } catch (e) {
    select.innerHTML = `<option value="">Không tải được dự án</option>`;
    showError((e as Error).message);
    // Mở phần cài đặt để người dùng sửa địa chỉ server
    const settings = document.querySelector<HTMLDetailsElement>('.settings');
    if (settings) settings.open = true;
  }
}

/* ---------- Ảnh ---------- */
/** Vẽ lại ảnh xem trước các ảnh người dùng đã thêm. */
function renderImages(): void {
  const box = $('bugImages');
  box.innerHTML = '';
  state.images.forEach((file, index) => {
    const url = URL.createObjectURL(file);
    const div = document.createElement('div');
    div.className = 'thumb';
    div.innerHTML = `<img alt=""><button type="button" title="Bỏ ảnh">×</button>`;
    const img = div.querySelector('img') as HTMLImageElement;
    img.src = url;
    img.onload = () => URL.revokeObjectURL(url);
    (div.querySelector('button') as HTMLButtonElement).onclick = () => {
      state.images.splice(index, 1);
      renderImages();
    };
    box.appendChild(div);
  });
}

/** Thêm ảnh (chọn file hoặc dán); bỏ file không phải ảnh và giữ tối đa MAX_IMAGES. */
function addImages(files: Iterable<File>): void {
  const room = MAX_IMAGES - state.images.length - ($<HTMLInputElement>('withScreenshot').checked && state.screenshot ? 1 : 0);
  const valid = [...files].filter((f) => IMAGE_TYPES.includes(f.type));
  if (valid.length > room) showError(`Tối đa ${MAX_IMAGES} ảnh (tính cả ảnh chụp màn hình).`);
  state.images.push(...valid.slice(0, Math.max(0, room)));
  renderImages();
}

/** Chụp phần nhìn thấy của tab hiện tại; không chụp được (trang chrome://, ...) thì tắt tuỳ chọn. */
async function captureScreenshot(): Promise<void> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(state.tab?.windowId as number, { format: 'png' });
    state.screenshot = await (await fetch(dataUrl)).blob();
    $<HTMLImageElement>('screenshotPreview').src = dataUrl;
    $('screenshotPreview').hidden = !$<HTMLInputElement>('withScreenshot').checked;
  } catch {
    $<HTMLInputElement>('withScreenshot').checked = false;
    $<HTMLInputElement>('withScreenshot').disabled = true;
    ($('withScreenshot').nextElementSibling as HTMLElement).textContent = 'Không chụp được màn hình trang này';
  }
}

/* ---------- HAR ---------- */
/** Hỏi background xem đang ghi log mạng thế nào và hiển thị cho người dùng. */
async function refreshHarStatus(): Promise<void> {
  state.harStatus = (await chrome.runtime.sendMessage({ type: 'bg:status', tabId: state.tab?.id })) as HarStatus;
  $('harStatus').textContent = state.harStatus.devtools
    ? 'DevTools đang mở: HAR lấy từ tab Network, có cả response body.'
    : `Đã ghi ${state.harStatus.count} request (có header/status, không có response body). ` +
      'Mở DevTools (F12) trước khi tái hiện lỗi nếu cần response body.';
}

/** Người dùng có chọn đính kèm HAR không. */
const withHar = (): boolean => document.querySelector<HTMLInputElement>('input[name="har"]:checked')?.value === '1';

/** Ẩn/hiện các tuỳ chọn HAR theo lựa chọn đính kèm. */
function toggleHarOptions(): void {
  $('harOptions').hidden = !withHar();
}

/** Lấy HAR: ưu tiên DevTools (có response body), không được thì dùng log ghi nền của background. */
async function collectHar(): Promise<Har> {
  const tabId = state.tab?.id;
  if (state.harStatus.devtools) {
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'devtools:getHar', tabId })) as { har?: Har } | undefined;
      if (res && res.har && res.har.log.entries.length) return res.har;
    } catch {
      // DevTools vừa đóng -> dùng log ghi nền
    }
  }
  const res = (await chrome.runtime.sendMessage({ type: 'bg:getHar', tabId })) as { har: Har };
  return res.har;
}

/** Che giá trị header/cookie nhạy cảm (token, cookie...) trước khi gửi HAR lên server. */
function redactHar(har: Har): Har {
  const clean = (headers: HarHeader[] | undefined): HarHeader[] =>
    (headers || []).map((h) => (SENSITIVE_HEADERS.test(h.name) ? { ...h, value: '[đã ẩn]' } : h));
  for (const entry of har.log.entries) {
    entry.request.headers = clean(entry.request.headers);
    entry.response.headers = clean(entry.response.headers);
    entry.request.cookies = (entry.request.cookies || []).map((c) => ({ ...c, value: '[đã ẩn]' }));
    entry.response.cookies = (entry.response.cookies || []).map((c) => ({ ...c, value: '[đã ẩn]' }));
  }
  return har;
}

/* ---------- Gửi ---------- */
/** Gửi báo lỗi: kiểm tra, ghép FormData (ảnh + HAR) rồi POST lên server. */
async function submit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  showError('');
  showSuccess('');

  const projectId = $<HTMLSelectElement>('project').value;
  if (!projectId) {
    showError('Vui lòng chọn dự án.');
    $('project').focus();
    return;
  }
  const bugText = $<Field>('bugText').value.trim();
  const useShot = $<HTMLInputElement>('withScreenshot').checked && state.screenshot;
  if (!bugText && !state.images.length && !useShot) {
    showError('Vui lòng nhập mô tả lỗi hoặc đính kèm ảnh.');
    $('bugText').focus();
    return;
  }

  const btn = $<HTMLButtonElement>('submit');
  btn.disabled = true;
  btn.textContent = 'Đang gửi...';

  try {
    const fd = new FormData();
    fd.set('project_id', projectId);
    fd.set('status', 'todo');
    fd.set('location_url', $<Field>('locationUrl').value.trim());
    fd.set('bug_text', bugText);
    fd.set('expected_text', $<Field>('expectedText').value.trim());
    if (useShot && state.screenshot)
      fd.append('bug_images', new File([state.screenshot], `screenshot-${stamp()}.png`, { type: 'image/png' }));
    state.images.forEach((f) => fd.append('bug_images', f));

    if (withHar()) {
      btn.textContent = 'Đang lấy HAR...';
      let har = await collectHar();
      if ($<HTMLInputElement>('redact').checked) har = redactHar(har);
      const name = `network-${hostOf(state.tab?.url)}-${stamp()}.har`;
      fd.set('har_file', new File([JSON.stringify(har)], name, { type: 'application/json' }));
      btn.textContent = 'Đang gửi...';
    }

    const item = await api<Feedback>('/api/feedbacks', { method: 'POST', body: fd });
    const projectName = $<HTMLSelectElement>('project').selectedOptions[0]?.textContent || '';

    await chrome.storage.local.set({ lastProjectId: projectId });
    await clearDraft();
    $<Field>('bugText').value = '';
    $<Field>('expectedText').value = '';
    state.images = [];
    renderImages();

    showSuccess(
      `Đã tạo backlog <b>#${esc(item.stt)}</b> · ${esc(projectName)}` +
        (item.har ? ' (kèm HAR)' : '') +
        ` — <a href="${esc(state.server)}/backlog" target="_blank">xem</a>`
    );
  } catch (e) {
    showError((e as Error).message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Gửi báo lỗi';
  }
}

/* ---------- Khởi tạo ---------- */
/** Khởi tạo popup: đọc cấu hình đã lưu, điền sẵn URL/tiêu đề trang, chụp màn hình và nạp dự án. */
async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('Không tìm thấy tab đang mở.');
  state.tab = tab;
  const stored = (await chrome.storage.local.get(['server', 'lastProjectId', 'withHar', 'redact'])) as {
    server?: string;
    lastProjectId?: string;
    withHar?: boolean;
    redact?: boolean;
  };
  state.server = normalizeServer(stored.server);

  $<Field>('serverUrl').value = state.server;
  $<HTMLAnchorElement>('openBacklog').href = state.server + '/backlog';
  $('pageTitle').textContent = tab.title || tab.url || '';
  $('pageTitle').title = tab.url || '';
  $<Field>('locationUrl').value = tab.url || '';
  if (stored.redact === false) $<HTMLInputElement>('redact').checked = false;

  const harValue = stored.withHar === false ? '0' : '1';
  document.querySelector<HTMLInputElement>(`input[name="har"][value="${harValue}"]`)!.checked = true;
  toggleHarOptions();

  const draft = await loadDraft();
  captureScreenshot();
  refreshHarStatus();
  await loadProjects((draft && draft.project) || stored.lastProjectId);
  $($<HTMLSelectElement>('project').value ? 'bugText' : 'project').focus();
}

/* ---------- Sự kiện ---------- */
$('form').addEventListener('submit', (e) => void submit(e as SubmitEvent));
$('form').addEventListener('input', () => state.tab && saveDraft());
$('form').addEventListener('change', () => state.tab && saveDraft());

$('pickImage').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => {
  const input = e.target as HTMLInputElement;
  addImages(input.files ?? []);
  input.value = '';
};
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => IMAGE_TYPES.includes(f.type));
  if (!files.length) return;
  e.preventDefault();
  addImages(files);
});

$('withScreenshot').onchange = () => {
  $('screenshotPreview').hidden = !$<HTMLInputElement>('withScreenshot').checked || !state.screenshot;
};

document.querySelectorAll<HTMLInputElement>('input[name="har"]').forEach((radio) =>
  radio.addEventListener('change', () => {
    toggleHarOptions();
    chrome.storage.local.set({ withHar: withHar() });
  })
);
$('redact').onchange = () => chrome.storage.local.set({ redact: $<HTMLInputElement>('redact').checked });

$('clearLog').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'bg:clear', tabId: state.tab?.id });
  await refreshHarStatus();
};

$('saveServer').onclick = async () => {
  state.server = normalizeServer($<Field>('serverUrl').value);
  $<Field>('serverUrl').value = state.server;
  $<HTMLAnchorElement>('openBacklog').href = state.server + '/backlog';
  await chrome.storage.local.set({ server: state.server });
  await loadProjects($<HTMLSelectElement>('project').value);
};

// Khởi động popup
init().catch((e: Error) => showError(e.message));

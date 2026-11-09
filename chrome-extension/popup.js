(() => {
  const $ = (id) => document.getElementById(id);
  const DEFAULT_SERVER = 'http://localhost:3000';
  const MAX_IMAGES = 10;
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const SENSITIVE_HEADERS = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token)$/i;

  const state = {
    tab: null,
    server: DEFAULT_SERVER,
    screenshot: null, // Blob
    images: [], // File[] người dùng thêm
    harStatus: { devtools: false, count: 0 },
  };

  /* ---------- Helpers ---------- */
  const normalizeServer = (url) => (url || '').trim().replace(/\/+$/, '') || DEFAULT_SERVER;

  function showError(message) {
    $('error').textContent = message || '';
    $('error').hidden = !message;
  }

  function showSuccess(html) {
    $('success').innerHTML = html || '';
    $('success').hidden = !html;
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  async function api(path, options) {
    let res;
    try {
      res = await fetch(state.server + path, options);
    } catch (e) {
      throw new Error(`Không kết nối được ${state.server}. Kiểm tra server đang chạy hoặc sửa địa chỉ trong "Cài đặt".`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
    return data;
  }

  const stamp = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };

  const hostOf = (url) => {
    try {
      return new URL(url).hostname || 'page';
    } catch (e) {
      return 'page';
    }
  };

  /* ---------- Bản nháp (popup tự đóng khi bấm ra ngoài) ---------- */
  const DRAFT_FIELDS = ['project', 'locationUrl', 'bugText', 'expectedText'];
  const draftKey = () => 'draft:' + state.tab.id;

  function saveDraft() {
    const draft = Object.fromEntries(DRAFT_FIELDS.map((id) => [id, $(id).value]));
    draft.pageUrl = state.tab.url;
    chrome.storage.session.set({ [draftKey()]: draft });
  }

  async function loadDraft() {
    const draft = (await chrome.storage.session.get(draftKey()))[draftKey()];
    if (!draft) return null;
    // URL vị trí chỉ khôi phục khi tab vẫn ở đúng trang lúc viết nháp.
    const fields = draft.pageUrl === state.tab.url ? ['locationUrl', 'bugText', 'expectedText'] : ['bugText', 'expectedText'];
    for (const id of fields) if (draft[id] != null) $(id).value = draft[id];
    return draft;
  }

  const clearDraft = () => chrome.storage.session.remove(draftKey());

  /* ---------- Dự án ---------- */
  async function loadProjects(selectedId) {
    const select = $('project');
    try {
      const projects = await api('/api/projects');
      projects.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
      select.innerHTML =
        `<option value="">— Chọn dự án —</option>` +
        projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
      if (!projects.length) select.innerHTML = `<option value="">Chưa có dự án – tạo trong trang backlog</option>`;
      const wanted = projects.some((p) => p.id === selectedId) ? selectedId : projects.length === 1 ? projects[0].id : '';
      select.value = wanted;
      showError('');
    } catch (e) {
      select.innerHTML = `<option value="">Không tải được dự án</option>`;
      showError(e.message);
      document.querySelector('.settings').open = true;
    }
  }

  /* ---------- Ảnh ---------- */
  function renderImages() {
    const box = $('bugImages');
    box.innerHTML = '';
    state.images.forEach((file, index) => {
      const url = URL.createObjectURL(file);
      const div = document.createElement('div');
      div.className = 'thumb';
      div.innerHTML = `<img alt=""><button type="button" title="Bỏ ảnh">×</button>`;
      div.querySelector('img').src = url;
      div.querySelector('img').onload = () => URL.revokeObjectURL(url);
      div.querySelector('button').onclick = () => {
        state.images.splice(index, 1);
        renderImages();
      };
      box.appendChild(div);
    });
  }

  function addImages(files) {
    const room = MAX_IMAGES - state.images.length - ($('withScreenshot').checked && state.screenshot ? 1 : 0);
    const valid = [...files].filter((f) => IMAGE_TYPES.includes(f.type));
    if (valid.length > room) showError(`Tối đa ${MAX_IMAGES} ảnh (tính cả ảnh chụp màn hình).`);
    state.images.push(...valid.slice(0, Math.max(0, room)));
    renderImages();
  }

  async function captureScreenshot() {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(state.tab.windowId, { format: 'png' });
      state.screenshot = await (await fetch(dataUrl)).blob();
      $('screenshotPreview').src = dataUrl;
      $('screenshotPreview').hidden = !$('withScreenshot').checked;
    } catch (e) {
      $('withScreenshot').checked = false;
      $('withScreenshot').disabled = true;
      $('withScreenshot').nextElementSibling.textContent = 'Không chụp được màn hình trang này';
    }
  }

  /* ---------- HAR ---------- */
  async function refreshHarStatus() {
    state.harStatus = await chrome.runtime.sendMessage({ type: 'bg:status', tabId: state.tab.id });
    $('harStatus').textContent = state.harStatus.devtools
      ? 'DevTools đang mở: HAR lấy từ tab Network, có cả response body.'
      : `Đã ghi ${state.harStatus.count} request (có header/status, không có response body). ` +
        'Mở DevTools (F12) trước khi tái hiện lỗi nếu cần response body.';
  }

  const withHar = () => document.querySelector('input[name="har"]:checked')?.value === '1';

  function toggleHarOptions() {
    $('harOptions').hidden = !withHar();
  }

  async function collectHar() {
    const tabId = state.tab.id;
    if (state.harStatus.devtools) {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'devtools:getHar', tabId });
        if (res && res.har && res.har.log.entries.length) return res.har;
      } catch (e) {
        // DevTools vừa đóng -> dùng log ghi nền
      }
    }
    const res = await chrome.runtime.sendMessage({ type: 'bg:getHar', tabId });
    return res.har;
  }

  function redactHar(har) {
    const clean = (headers) =>
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
  async function submit(event) {
    event.preventDefault();
    showError('');
    showSuccess('');

    const projectId = $('project').value;
    if (!projectId) {
      showError('Vui lòng chọn dự án.');
      $('project').focus();
      return;
    }
    const bugText = $('bugText').value.trim();
    const useShot = $('withScreenshot').checked && state.screenshot;
    if (!bugText && !state.images.length && !useShot) {
      showError('Vui lòng nhập mô tả lỗi hoặc đính kèm ảnh.');
      $('bugText').focus();
      return;
    }

    const btn = $('submit');
    btn.disabled = true;
    btn.textContent = 'Đang gửi...';

    try {
      const fd = new FormData();
      fd.set('project_id', projectId);
      fd.set('status', 'todo');
      fd.set('location_url', $('locationUrl').value.trim());
      fd.set('bug_text', bugText);
      fd.set('expected_text', $('expectedText').value.trim());
      if (useShot) fd.append('bug_images', new File([state.screenshot], `screenshot-${stamp()}.png`, { type: 'image/png' }));
      state.images.forEach((f) => fd.append('bug_images', f));

      if (withHar()) {
        btn.textContent = 'Đang lấy HAR...';
        let har = await collectHar();
        if ($('redact').checked) har = redactHar(har);
        const name = `network-${hostOf(state.tab.url)}-${stamp()}.har`;
        fd.set('har_file', new File([JSON.stringify(har)], name, { type: 'application/json' }));
        btn.textContent = 'Đang gửi...';
      }

      const item = await api('/api/feedbacks', { method: 'POST', body: fd });
      const projectName = $('project').selectedOptions[0]?.textContent || '';

      await chrome.storage.local.set({ lastProjectId: projectId });
      await clearDraft();
      $('bugText').value = '';
      $('expectedText').value = '';
      state.images = [];
      renderImages();

      showSuccess(
        `Đã tạo backlog <b>#${esc(item.stt)}</b> · ${esc(projectName)}` +
          (item.har ? ' (kèm HAR)' : '') +
          ` — <a href="${esc(state.server)}/#/backlog" target="_blank">xem</a>`
      );
    } catch (e) {
      showError(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Gửi báo lỗi';
    }
  }

  /* ---------- Khởi tạo ---------- */
  async function init() {
    [state.tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const stored = await chrome.storage.local.get(['server', 'lastProjectId', 'withHar', 'redact']);
    state.server = normalizeServer(stored.server);

    $('serverUrl').value = state.server;
    $('openBacklog').href = state.server + '/#/backlog';
    $('pageTitle').textContent = state.tab.title || state.tab.url || '';
    $('pageTitle').title = state.tab.url || '';
    $('locationUrl').value = state.tab.url || '';
    if (stored.redact === false) $('redact').checked = false;

    const harValue = stored.withHar === false ? '0' : '1';
    document.querySelector(`input[name="har"][value="${harValue}"]`).checked = true;
    toggleHarOptions();

    const draft = await loadDraft();
    captureScreenshot();
    refreshHarStatus();
    await loadProjects((draft && draft.project) || stored.lastProjectId);
    $(($('project').value ? 'bugText' : 'project')).focus();
  }

  /* ---------- Sự kiện ---------- */
  $('form').addEventListener('submit', submit);
  $('form').addEventListener('input', () => state.tab && saveDraft());
  $('form').addEventListener('change', () => state.tab && saveDraft());

  $('pickImage').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => {
    addImages(e.target.files);
    e.target.value = '';
  };
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => IMAGE_TYPES.includes(f.type));
    if (!files.length) return;
    e.preventDefault();
    addImages(files);
  });

  $('withScreenshot').onchange = () => {
    $('screenshotPreview').hidden = !$('withScreenshot').checked || !state.screenshot;
  };

  document.querySelectorAll('input[name="har"]').forEach((radio) =>
    radio.addEventListener('change', () => {
      toggleHarOptions();
      chrome.storage.local.set({ withHar: withHar() });
    })
  );
  $('redact').onchange = () => chrome.storage.local.set({ redact: $('redact').checked });

  $('clearLog').onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'bg:clear', tabId: state.tab.id });
    await refreshHarStatus();
  };

  $('saveServer').onclick = async () => {
    state.server = normalizeServer($('serverUrl').value);
    $('serverUrl').value = state.server;
    $('openBacklog').href = state.server + '/#/backlog';
    await chrome.storage.local.set({ server: state.server });
    await loadProjects($('project').value);
  };

  init().catch((e) => showError(e.message));
})();

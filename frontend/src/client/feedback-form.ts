/**
 * Form thêm / sửa backlog (modal): vùng ảnh (chọn file, kéo thả, dán Ctrl+V), chip chọn nhanh,
 * ghi nhớ lựa chọn lần trước và gửi form (multipart) tới `/api/feedbacks`.
 *
 * Server đã render sẵn mọi lựa chọn (dự án, team, loại, trạng thái) và mẫu ảnh xem trước (`<template>`);
 * code ở đây chỉ điền giá trị, bật/tắt trạng thái chọn và gửi dữ liệu.
 */
import type { Feedback } from '../types.js';
import { api } from './api.js';
import { $, $$, closest, data, errorMessage, isOpen, maybe, openModal, setError, showToast } from './dom.js';
import type { Field } from './dom.js';
import { openProjectForm, registerForm } from './crud.js';

/** Số ảnh tối đa mỗi vùng ảnh (khớp giới hạn của server). */
const MAX_IMAGES = 10;
/** Class đánh dấu vùng ảnh đang nhận Ctrl+V. */
const ZONE_ACTIVE = ['border-indigo-300', 'bg-indigo-50/40'];
/** Class đánh dấu ô thả file khi đang kéo ảnh vào. */
const DROP_ACTIVE = ['border-indigo-500', 'bg-indigo-50'];
/** Khóa localStorage lưu lựa chọn lần trước (dự án / loại / team) để nhập nhanh. */
const DEFAULTS_KEY = 'backlogDefaults';

/** Tên ba vùng nhận ảnh trong form. */
type ZoneName = 'location' | 'bug' | 'expected';

/** Một vùng ảnh: ảnh đã lưu trên server, file mới chọn và danh sách ảnh sẽ xóa khi lưu. */
interface Zone {
  /** Cho phép nhiều ảnh (false = chỉ một ảnh). */
  multi: boolean;
  /** URL các ảnh đã có trên server. */
  existing: string[];
  /** File mới người dùng vừa thêm (chưa tải lên). */
  files: File[];
  /** URL các ảnh đã có mà người dùng bấm xóa (gửi lên server khi lưu). */
  removed: string[];
}

/** Dữ liệu ba vùng ảnh. */
const zones: Record<ZoneName, Zone> = {
  location: { multi: false, existing: [], files: [], removed: [] },
  bug: { multi: true, existing: [], files: [], removed: [] },
  expected: { multi: true, existing: [], files: [], removed: [] },
};

/** Blob URL của từng File đang xem trước (thu hồi khi không dùng nữa, tránh rò bộ nhớ). */
const objectUrls = new Map<File, string>();
const blobUrl = (file: File): string => {
  if (!objectUrls.has(file)) objectUrls.set(file, URL.createObjectURL(file));
  return objectUrls.get(file) as string;
};
const releaseBlob = (file: File): void => {
  const url = objectUrls.get(file);
  if (url) URL.revokeObjectURL(url);
  objectUrls.delete(file);
};

/** Đọc lựa chọn lần trước; lỗi hoặc chưa có -> rỗng. */
const loadDefaults = (): { project?: string; type?: string; team?: string } => {
  try {
    return JSON.parse(localStorage.getItem(DEFAULTS_KEY) ?? 'null') || {};
  } catch {
    return {};
  }
};

/** Lưu lựa chọn lần này để điền sẵn cho lần nhập sau. */
const saveDefaults = (d: { project: string; type: string; team: string }): void => {
  try {
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d));
  } catch {
    // storage bị chặn -> chỉ mất tính năng nhớ lựa chọn
  }
};

/** Dung lượng ảnh tối đa mỗi request (0 = không giới hạn); lấy một lần từ server. */
let maxUploadBytes: number | null = null;

/** Thu nhỏ ảnh lớn (cạnh dài tối đa 2560px, nén WebP) để không vượt giới hạn upload ~4MB / lần của Vercel. */
const shrinkImage = async (file: File): Promise<File> => {
  if (file.type === 'image/gif' || file.size <= 700 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.webp', { type: 'image/webp' });
  } catch {
    return file; // không nén được thì giữ nguyên
  }
};

/** Gắn form backlog (nếu trang có modal backlog). */
export function initFeedbackForm(): void {
  const modal = maybe('#modal');
  if (!modal) return;

  const form = $<HTMLFormElement>('#form');
  const f = {
    project: $<Field>('#fProject'),
    status: $<Field>('#fStatus'),
    team: $<Field>('#fTeam'),
    type: $<Field>('#fType'),
    title: $<Field>('#fTitle'),
    note: $<Field>('#fNote'),
    locationUrl: $<Field>('#fLocationUrl'),
    bugText: $<Field>('#fBugText'),
    expectedText: $<Field>('#fExpectedText'),
  };
  const noteBox = $<HTMLDetailsElement>('#fNoteBox');
  const metaBox = $<HTMLDetailsElement>('#fMeta');
  const errorBox = $('#formError');
  const nextStt = JSON.parse(form.dataset.nextStt ?? '{}') as Record<string, number>;
  let editing: Feedback | null = null;
  /** Đã lưu ít nhất một backlog khi đang "Lưu & thêm tiếp" -> tải lại trang khi đóng form để thấy danh sách mới. */
  let dirty = false;
  let activeZone: ZoneName = 'bug';

  /** Giá trị có nằm trong danh sách <option> của select không. */
  const hasOption = (select: Field, value: string): boolean => [...(select as HTMLSelectElement).options].some((o) => o.value === value);
  /** Nhãn hiển thị của <option> đang chọn. */
  const selectedLabel = (select: Field): string => (select as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? '';

  /* ---------- Vùng ảnh ---------- */

  /** Vẽ lại ảnh xem trước của một vùng bằng cách nhân bản <template id="tplPreview"> do server render. */
  const renderZone = (name: ZoneName): void => {
    const z = zones[name];
    const tpl = $<HTMLTemplateElement>('#tplPreview');
    const make = (src: string, kind: 'existing' | 'new', index: number): DocumentFragment => {
      const node = tpl.content.cloneNode(true) as DocumentFragment;
      const img = node.querySelector('img') as HTMLImageElement;
      img.src = src;
      img.dataset.zoom = src;
      const btn = node.querySelector('button') as HTMLButtonElement;
      btn.dataset.remove = kind;
      btn.dataset.index = String(index);
      return node;
    };
    $(`[data-preview="${name}"]`).replaceChildren(
      ...z.existing.map((url, i) => make(url, 'existing', i)),
      ...z.files.map((file, i) => make(blobUrl(file), 'new', i))
    );
  };

  /** Đặt lại một vùng ảnh (giải phóng blob, nạp ảnh đã có nếu đang sửa). */
  const resetZone = (name: ZoneName, existing: string[] = []): void => {
    const z = zones[name];
    z.files.forEach(releaseBlob);
    z.existing = [...existing];
    z.files = [];
    z.removed = [];
    renderZone(name);
  };

  /** Thêm ảnh vào một vùng (chọn file, kéo thả hoặc dán): thu nhỏ rồi giữ tối đa MAX_IMAGES; vùng một ảnh thì thay ảnh cũ. */
  const addFiles = async (name: ZoneName, fileList: Iterable<File>): Promise<void> => {
    const z = zones[name];
    const picked = [...fileList].filter((file) => file.type.startsWith('image/'));
    if (!picked.length) return;
    const images = await Promise.all(picked.map(shrinkImage));
    if (!z.multi) {
      z.removed.push(...z.existing);
      z.existing = [];
      z.files.forEach(releaseBlob);
      z.files = [images[0] as File];
    } else {
      const room = MAX_IMAGES - z.existing.length - z.files.length;
      z.files.push(...images.slice(0, Math.max(room, 0)));
    }
    renderZone(name);
  };

  /** Đánh dấu vùng ảnh sẽ nhận ảnh khi dán (Ctrl+V). */
  const setActiveZone = (name: ZoneName): void => {
    activeZone = name;
    $$('[data-zone]').forEach((section) => {
      const active = data(section, 'zone') === name;
      section.classList.toggle('border-transparent', !active);
      ZONE_ACTIVE.forEach((c) => section.classList.toggle(c, active));
    });
  };

  /* ---------- Chip chọn nhanh & tóm tắt ---------- */

  /** Gợi ý STT sẽ được cấp cho backlog đang nhập. */
  const updateSttHint = (): void => {
    const hint = $('#sttHint');
    const projectId = f.project.value;
    if (!(f.project as HTMLSelectElement).options.length || (f.project as HTMLSelectElement).options.length === 1) {
      hint.textContent = 'Chưa có dự án nào — chọn "+ Dự án mới" để tạo.';
      return;
    }
    if (editing) {
      hint.textContent =
        projectId && projectId !== editing.projectId
          ? `Đổi dự án: STT sẽ được cấp lại thành ${nextStt[projectId] ?? 1}.`
          : `STT hiện tại: ${editing.stt}.`;
      return;
    }
    hint.textContent = projectId
      ? `Backlog này sẽ có STT ${nextStt[projectId] ?? 1} trong dự án "${selectedLabel(f.project)}".`
      : 'STT được tự động đánh số theo từng dự án.';
  };

  /** Dòng tóm tắt phần phân loại (dự án · loại · team · trạng thái). */
  const updateMetaSummary = (): void => {
    const summary = $('#metaSummary');
    const projectId = f.project.value;
    summary.textContent = projectId
      ? [
          selectedLabel(f.project),
          f.type.value.trim() || 'Chưa chọn loại',
          selectedLabel(f.team) || 'Chưa phân công',
          selectedLabel(f.status),
        ].join(' · ')
      : '⚠ Chưa chọn dự án';
    summary.classList.toggle('text-red-600', !projectId);
    summary.classList.toggle('text-slate-700', Boolean(projectId));
  };

  /** Bật `aria-pressed` cho chip khớp giá trị hiện tại của form (CSS lo phần tô màu). */
  const syncChips = (): void => {
    const type = f.type.value.trim().toLowerCase();
    $$('[data-chip-type]').forEach((c) => c.setAttribute('aria-pressed', String(data(c, 'chipType').toLowerCase() === type)));
    $$('[data-chip-team]').forEach((c) => c.setAttribute('aria-pressed', String(data(c, 'chipTeam') === f.team.value)));
    $$('[data-chip-status]').forEach((c) => c.setAttribute('aria-pressed', String(data(c, 'chipStatus') === f.status.value)));
    updateMetaSummary();
  };

  /* ---------- Mở / đóng ---------- */

  /** Mở form: sửa `item` hoặc thêm mới (null); điền sẵn lựa chọn lần trước khi thêm mới. */
  const open = (item: Feedback | null = null): void => {
    editing = item;
    form.reset();
    setError(errorBox, '');
    $('#modalTitle').textContent = item ? `Sửa backlog #${item.stt}` : 'Thêm backlog';
    $('#btnSaveNew').classList.toggle('hidden', Boolean(item)); // "Lưu & thêm tiếp" chỉ khi thêm mới

    const d = loadDefaults();
    const optionCount = (f.project as HTMLSelectElement).options.length - 1; // trừ dòng "— Chọn dự án —"
    f.project.value = item
      ? item.projectId
      : form.dataset.currentProject ||
        (d.project && hasOption(f.project, d.project) ? d.project : '') ||
        (optionCount === 1 ? ((f.project as HTMLSelectElement).options[1]?.value ?? '') : '');
    f.status.value = item ? item.status : 'todo';
    f.team.value = item ? item.teamId : form.dataset.currentTeam || (d.team && hasOption(f.team, d.team) ? d.team : '');
    f.type.value = item ? item.type : d.type || '';
    f.title.value = item ? item.title : '';
    f.note.value = item ? item.note : '';
    noteBox.open = Boolean(item && item.note);
    f.locationUrl.value = item ? item.location.url : '';
    f.bugText.value = item ? item.bug.text : '';
    f.expectedText.value = item ? item.expected.text : '';

    resetZone('location', item && item.location.image ? [item.location.image] : []);
    resetZone('bug', item ? item.bug.images : []);
    resetZone('expected', item ? item.expected.images : []);

    // File HAR đính kèm (chỉ xem / gỡ, không thay trong form này)
    const har = item?.har;
    const harBox = $('#fHarBox');
    harBox.classList.toggle('hidden', !har);
    harBox.classList.toggle('flex', Boolean(har));
    $<HTMLInputElement>('#fRemoveHar').checked = false;
    if (har) {
      const link = $<HTMLAnchorElement>('#fHarLink');
      link.href = har.url;
      link.download = har.name;
      link.textContent = har.name;
    }

    syncChips();
    updateSttHint();
    setActiveZone('bug');
    metaBox.open = !f.project.value; // chưa có dự án -> mở sẵn phần phân loại
    openModal(modal);
    (f.project.value ? f.title : f.project).focus();
  };
  registerForm('feedback', open);

  // Đóng form: nếu đã lưu liên tiếp thì tải lại để danh sách khớp dữ liệu mới
  modal.addEventListener('modal:closed', () => {
    editing = null;
    if (dirty) location.reload();
  });

  /** Sau "Lưu & thêm tiếp": xóa nội dung lỗi, giữ nguyên dự án / loại / team / trạng thái. */
  const resetForNext = (): void => {
    [f.title, f.locationUrl, f.bugText, f.expectedText, f.note].forEach((el) => (el.value = ''));
    noteBox.open = false;
    (['location', 'bug', 'expected'] as ZoneName[]).forEach((z) => resetZone(z));
    setError(errorBox, '');
    syncChips();
    updateSttHint();
    f.title.focus();
    f.title.scrollIntoView({ block: 'center' });
  };

  /* ---------- Gửi form ---------- */

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError(errorBox, '');

    const projectId = f.project.value;
    if (!projectId) {
      metaBox.open = true;
      setError(errorBox, 'Vui lòng chọn dự án.');
      f.project.focus();
      return;
    }
    if (!f.title.value.trim() && !f.bugText.value.trim()) {
      setError(errorBox, 'Nhập tên lỗi hoặc mô tả lỗi.');
      f.title.focus();
      return;
    }

    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
    const keepOpen = !editing && submitter?.id === 'btnSaveNew';
    const fd = new FormData();
    fd.set('project_id', projectId);
    fd.set('status', f.status.value);
    fd.set('team_id', f.team.value);
    fd.set('type', f.type.value);
    fd.set('title', f.title.value);
    fd.set('note_text', f.note.value);
    fd.set('location_url', f.locationUrl.value);
    fd.set('bug_text', f.bugText.value);
    fd.set('expected_text', f.expectedText.value);
    zones.location.files.forEach((file) => fd.append('location_image', file));
    zones.bug.files.forEach((file) => fd.append('bug_images', file));
    zones.expected.files.forEach((file) => fd.append('expected_images', file));

    // Trên Vercel mỗi request chỉ nhận ~4MB: báo sớm thay vì để server từ chối sau khi đã tải lên
    if (maxUploadBytes === null)
      maxUploadBytes = (await api<{ maxUploadBytes?: number }>('/api/mcp-info').catch(() => ({ maxUploadBytes: 0 }))).maxUploadBytes ?? 0;
    const totalBytes = (['location', 'bug', 'expected'] as ZoneName[]).reduce(
      (n, z) => n + zones[z].files.reduce((m, file) => m + file.size, 0),
      0
    );
    if (maxUploadBytes && totalBytes > maxUploadBytes) {
      setError(
        errorBox,
        `Tổng dung lượng ảnh ${(totalBytes / 1048576).toFixed(1)}MB vượt giới hạn ${(maxUploadBytes / 1048576).toFixed(1)}MB mỗi lần lưu. Hãy bớt ảnh rồi lưu, sau đó thêm ảnh còn lại bằng nút Sửa.`
      );
      return;
    }

    if (editing) {
      if (zones.location.removed.length) fd.set('remove_location_image', '1');
      fd.set('remove_bug_images', JSON.stringify(zones.bug.removed));
      fd.set('remove_expected_images', JSON.stringify(zones.expected.removed));
      if ($<HTMLInputElement>('#fRemoveHar').checked) fd.set('remove_har', '1');
    }

    const buttons = [$<HTMLButtonElement>('#btnSave'), $<HTMLButtonElement>('#btnSaveNew')];
    const btn = submitter ?? buttons[0]!;
    const label = btn.textContent;
    buttons.forEach((b) => (b.disabled = true));
    btn.textContent = 'Đang lưu...';
    try {
      const saved = await api<Feedback>(editing ? `/api/feedbacks/${editing.id}` : '/api/feedbacks', {
        method: editing ? 'PUT' : 'POST',
        body: fd,
      });
      saveDefaults({ project: projectId, type: f.type.value.trim(), team: f.team.value });
      if (keepOpen) {
        dirty = true;
        nextStt[projectId] = saved.stt + 1;
        resetForNext();
        showToast(`Đã lưu #${saved.stt} · nhập tiếp`);
      } else {
        location.reload();
      }
    } catch (err) {
      setError(errorBox, errorMessage(err));
    } finally {
      buttons.forEach((b) => (b.disabled = false));
      btn.textContent = label;
    }
  });

  /* ---------- Sự kiện trong form ---------- */

  f.project.addEventListener('change', () => {
    updateSttHint();
    updateMetaSummary();
  });
  f.type.addEventListener('input', syncChips);

  // Chọn nhanh bằng một chạm (bấm lại chip loại để bỏ chọn)
  $('#fMeta').addEventListener('click', (e) => {
    const type = closest(e, '[data-chip-type]');
    const team = closest(e, '[data-chip-team]');
    const status = closest(e, '[data-chip-status]');
    if (type) f.type.value = f.type.value.trim().toLowerCase() === data(type, 'chipType').toLowerCase() ? '' : data(type, 'chipType');
    else if (team) f.team.value = data(team, 'chipTeam');
    else if (status) f.status.value = data(status, 'chipStatus');
    else return;
    syncChips();
  });

  // "+ Dự án mới": tạo dự án rồi chọn luôn nó trong form này (không tải lại trang)
  $('#btnQuickProject').addEventListener('click', () =>
    openProjectForm((project: { id: string; name: string; code?: string }) => {
      const select = f.project as HTMLSelectElement;
      select.add(new Option(project.code ? `${project.code} - ${project.name}` : project.name, project.id));
      select.value = project.id;
      nextStt[project.id] = 1;
      dirty = true;
      updateSttHint();
      updateMetaSummary();
      metaBox.open = true; // giữ mở để chọn tiếp loại / team
      f.title.focus();
    })
  );

  // Vùng nhận ảnh khi dán: vùng đang trỏ chuột / focus
  $$('[data-zone]').forEach((section) => {
    const name = data(section, 'zone') as ZoneName;
    ['mouseenter', 'focusin', 'click'].forEach((type) => section.addEventListener(type, () => setActiveZone(name)));
  });
  $$('[data-pick]').forEach((btn) =>
    btn.addEventListener('click', () => $<HTMLInputElement>(`[data-input="${data(btn, 'pick')}"]`).click())
  );
  $$<HTMLInputElement>('[data-input]').forEach((input) =>
    input.addEventListener('change', () => {
      void addFiles(data(input, 'input') as ZoneName, input.files ?? []);
      input.value = '';
    })
  );
  $$('[data-dropzone]').forEach((box) => {
    const name = data(box, 'dropzone') as ZoneName;
    const setDrop = (on: boolean): void => DROP_ACTIVE.forEach((c) => box.classList.toggle(c, on));
    ['dragenter', 'dragover'].forEach((type) =>
      box.addEventListener(type, (e) => {
        e.preventDefault();
        setDrop(true);
      })
    );
    box.addEventListener('dragleave', () => setDrop(false));
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      setDrop(false);
      void addFiles(name, (e as DragEvent).dataTransfer?.files ?? []);
    });
  });

  // Xóa ảnh trong form (ảnh đã lưu thì ghi nhớ để server xóa khi lưu)
  modal.addEventListener('click', (e) => {
    const btn = closest(e, '[data-remove]');
    const preview = btn?.closest<HTMLElement>('[data-preview]');
    if (!btn || !preview) return;
    const name = data(preview, 'preview') as ZoneName;
    const z = zones[name];
    const index = Number(data(btn, 'index'));
    if (data(btn, 'remove') === 'existing') z.removed.push(...z.existing.splice(index, 1));
    else z.files.splice(index, 1).forEach(releaseBlob);
    renderZone(name);
  });

  // Dán ảnh từ clipboard (Ctrl+V) vào vùng đang chọn
  document.addEventListener('paste', (e) => {
    const other = $$('[data-modal]').some((m) => m !== modal && isOpen(m));
    if (!isOpen(modal) || other || !e.clipboardData) return;
    const files = [...e.clipboardData.items]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!files.length) return; // dán text bình thường
    e.preventDefault();
    void addFiles(activeZone, files);
  });

  // Đóng form bằng nút Hủy / × đã do ui.ts xử lý; ở đây chỉ cần dọn blob khi đóng
  modal.addEventListener('modal:closed', () => (['location', 'bug', 'expected'] as ZoneName[]).forEach((z) => resetZone(z)));
}

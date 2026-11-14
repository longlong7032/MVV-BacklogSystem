import { api } from './api.js';
import { $, closest, errorMessage, maybe, openModal, closeModal, setError, showToast } from './dom.js';
import { confirmDialog } from './dialog.js';

interface PaymentRound {
  idPublic: string;
  name: string;
  amount: number;
  note: string;
  paidAt: string;
  image: string;
  paid: boolean;
  companyAccount: boolean;
  invoiceFeedbackId?: string;
}

const setValue = (form: HTMLFormElement, name: string, value: string): void => {
  (form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement).value = value;
};

export function initPaymentRounds(): void {
  const modal = maybe('#paymentModal');
  const form = maybe<HTMLFormElement>('#paymentForm');
  if (!modal || !form) return;
  const error = $('[data-payment-error]', form);
  const submit = $('[data-payment-submit]', form) as HTMLButtonElement;
  const title = $('[data-payment-title]', form);
  const currentImage = $('[data-current-image]', form);
  const imagePreview = $('[data-current-image-preview]', form) as HTMLImageElement;
  let editing: PaymentRound | null = null;

  const open = (item: PaymentRound | null, markPaid = false): void => {
    editing = item;
    form.reset();
    setError(error, '');
    title.textContent = item ? 'Sửa đợt thanh toán' : 'Thêm đợt thanh toán';
    submit.textContent = item ? 'Lưu thay đổi' : 'Lưu đợt';
    if (item) {
      setValue(form, 'name', item.name);
      setValue(form, 'amount', String(item.amount));
      setValue(form, 'note', item.note || '');
      setValue(form, 'paid_at', item.paidAt || '');
    }
    (form.elements.namedItem('paid') as HTMLInputElement).checked = markPaid || Boolean(item?.paid);
    (form.elements.namedItem('company_account') as HTMLInputElement).checked = Boolean(item?.companyAccount);
    currentImage.classList.toggle('hidden', !item?.image);
    currentImage.classList.toggle('flex', Boolean(item?.image));
    if (item?.image) imagePreview.src = item.image;
    else imagePreview.removeAttribute('src');
    openModal(modal);
  };

  document.addEventListener('click', async (event) => {
    const add = closest(event, '[data-payment-add]');
    if (add) return open(null);
    const invoiceProject = closest(event, '[data-invoice-project]');
    if (invoiceProject) {
      const ok = await confirmDialog({ title: 'Tạo việc xuất hóa đơn tổng?', message: 'Hệ thống tạo một backlog tổng hợp để xuất hóa đơn cho các đợt thanh toán qua tài khoản công ty của dự án.', confirmLabel: 'Tạo backlog' });
      if (!ok) return;
      try {
        await api(invoiceProject.getAttribute('data-invoice-project') || '', { method: 'POST' });
        location.reload();
      } catch (err) { showToast(errorMessage(err)); }
      return;
    }
    const close = closest(event, '[data-payment-close]');
    if (close) return closeModal(modal);
    const edit = closest(event, '[data-payment-edit]');
    if (edit) {
      const holder = edit.closest<HTMLElement>('[data-payment-item]');
      if (holder?.dataset.paymentItem) open(JSON.parse(holder.dataset.paymentItem) as PaymentRound);
      return;
    }
    const toggle = closest(event, '[data-payment-toggle]');
    if (toggle) {
      const holder = toggle.closest<HTMLElement>('[data-payment-item]');
      if (!holder?.dataset.paymentItem) return;
      const item = JSON.parse(holder.dataset.paymentItem) as PaymentRound;
      if (!item.paid && (!item.image || !item.paidAt)) return open(item, true);
      try {
        await api(`/api/payments/${encodeURIComponent(item.idPublic)}/status`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid: !item.paid }),
        });
        location.reload();
      } catch (err) { showToast(errorMessage(err)); }
      return;
    }
    const invoicePayment = closest(event, '[data-payment-invoice]');
    if (invoicePayment) {
      const holder = invoicePayment.closest<HTMLElement>('[data-payment-item]');
      if (!holder?.dataset.paymentItem) return;
      const item = JSON.parse(holder.dataset.paymentItem) as PaymentRound;
      const ok = await confirmDialog({ title: `Tạo việc xuất hóa đơn cho đợt “${item.name}”?`, message: 'Một backlog mới sẽ được tạo trong dự án.', confirmLabel: 'Tạo backlog' });
      if (!ok) return;
      try {
        await api(`/api/payments/${encodeURIComponent(item.idPublic)}/invoice-task`, { method: 'POST' });
        location.reload();
      } catch (err) { showToast(errorMessage(err)); }
      return;
    }
    const remove = closest(event, '[data-payment-delete]');
    if (remove) {
      const holder = remove.closest<HTMLElement>('[data-payment-item]');
      if (!holder?.dataset.paymentItem) return;
      const item = JSON.parse(holder.dataset.paymentItem) as PaymentRound;
      const ok = await confirmDialog({ title: `Xóa đợt thanh toán “${item.name}”?`, message: 'Hành động này không thể hoàn tác.', confirmLabel: 'Xóa', danger: true });
      if (!ok) return;
      try {
        await api(`/api/payments/${encodeURIComponent(item.idPublic)}`, { method: 'DELETE' });
        location.reload();
      } catch (err) {
        showToast(errorMessage(err));
      }
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError(error, '');
    const name = (form.elements.namedItem('name') as HTMLInputElement).value.trim();
    const amount = Number((form.elements.namedItem('amount') as HTMLInputElement).value);
    if (!name) return setError(error, 'Vui lòng nhập tên đợt thanh toán.');
    if (!Number.isFinite(amount) || amount < 0) return setError(error, 'Vui lòng nhập số tiền hợp lệ.');
    const paid = (form.elements.namedItem('paid') as HTMLInputElement).checked;
    const paidAt = (form.elements.namedItem('paid_at') as HTMLInputElement).value;
    const image = form.elements.namedItem('payment_image') as HTMLInputElement;
    if (paid && !paidAt) return setError(error, 'Nhập ngày thanh toán trước khi đánh dấu đã thanh toán.');
    const removeImage = form.elements.namedItem('remove_image') as HTMLInputElement;
    if (paid && !image.files?.length && (!editing?.image || removeImage.checked)) return setError(error, 'Đính kèm hình ảnh biên nhận khi đánh dấu đã thanh toán.');
    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = 'Đang lưu...';
    try {
      const body = new FormData(form);
      if (!image.files?.length) body.delete('payment_image');
      if (!removeImage.checked) body.delete('remove_image');
      await api(editing ? `/api/payments/${encodeURIComponent(editing.idPublic)}` : '/api/payments', {
        method: editing ? 'PUT' : 'POST',
        body,
      });
      closeModal(modal);
      location.reload();
    } catch (err) {
      setError(error, errorMessage(err));
    } finally {
      submit.disabled = false;
      submit.textContent = label;
    }
  });
}

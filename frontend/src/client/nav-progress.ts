/** Thanh tiến trình mảnh ở đầu trang khi chuyển trang (trang render phía server nên cần phản hồi ngay khi bấm). */
export function initNavProgress(): void {
  const bar = document.createElement('div');
  bar.setAttribute('aria-hidden', 'true');
  bar.style.cssText =
    'position:fixed;top:0;left:0;height:3px;width:0;background:oklch(var(--p));z-index:9999;opacity:0;pointer-events:none;transition:width 8s cubic-bezier(.1,.7,.1,1),opacity .2s';
  document.body.appendChild(bar);

  const start = (): void => {
    bar.style.opacity = '1';
    bar.style.width = '85%';
  };
  const reset = (): void => {
    bar.style.transition = 'none';
    bar.style.width = '0';
    bar.style.opacity = '0';
    void bar.offsetWidth; // áp dụng style trước khi bật lại transition
    bar.style.transition = '';
  };

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;
    if (url.pathname === location.pathname && url.search === location.search) return; // chỉ đổi #hash
    start();
  });
  // Quay lại từ bfcache: bỏ thanh đang chạy dở
  window.addEventListener('pageshow', reset);
}

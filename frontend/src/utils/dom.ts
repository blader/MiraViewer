export function hasEditableAncestor(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  let el: HTMLElement | null = target;
  while (el) {
    if (el.isContentEditable) return true;

    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;

    if (tag === 'INPUT') {
      const type = (el as HTMLInputElement).type;
      // Allow wheel slicing over range inputs (e.g. the global slice slider).
      if (type !== 'range') {
        return true;
      }
    }

    el = el.parentElement;
  }

  return false;
}

export function hasScrollableAncestor(
  target: EventTarget | null,
  deltaY: number,
  stopAt?: HTMLElement | null
): boolean {
  if (!(target instanceof HTMLElement)) return false;

  const dir = Math.sign(deltaY);
  if (dir === 0) return false;

  let el: HTMLElement | null = target;

  while (el) {
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    const scrollableY =
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      el.scrollHeight > el.clientHeight + 1;

    if (scrollableY) {
      // Only treat it as scrollable if this wheel event would actually scroll it.
      if (dir > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
      if (dir < 0 && el.scrollTop > 0) return true;
    }

    if (stopAt && el === stopAt) break;

    el = el.parentElement;
  }

  return false;
}

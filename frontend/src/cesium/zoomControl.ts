/** A Viewer-owned native input; no timers, global handlers or camera movement. */
export function attachZoomControl(container: HTMLElement, onChange: (value: number) => void): { destroy(): void } {
  const doc = container.ownerDocument;
  const group = doc.createElement('div');
  group.className = 'zoom-control';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Map zoom controls');
  const label = doc.createElement('label');
  const caption = doc.createElement('span');
  caption.textContent = 'Zoom sensitivity';
  const output = doc.createElement('output');
  output.textContent = '10.00×';
  output.setAttribute('aria-hidden', 'true');
  const input = doc.createElement('input');
  input.type = 'range';
  input.min = '0.25';
  input.max = '10';
  input.step = '0.25';
  input.value = '10';
  input.setAttribute('aria-label', 'Zoom sensitivity');
  input.setAttribute('aria-valuetext', '10.00×');
  const hint = doc.createElement('span');
  hint.className = 'zoom-hint';
  hint.textContent = 'Slower  ←  →  Faster';
  let disposed = false, value = 10, listenerRemoved = false, elementRemoved = false;
  const change = () => {
    if (disposed) return;
    const next = Number(input.value);
    if (!Number.isFinite(next) || next < 0.25 || next > 10 || !Number.isInteger(next * 4)) {
      input.value = String(value);
      return;
    }
    try { onChange(next); } catch (error) { input.value = String(value); throw error; }
    value = next;
    output.textContent = `${value.toFixed(2)}×`;
    input.setAttribute('aria-valuetext', `${value.toFixed(2)}×`);
  };
  label.append(caption, output, input);
  group.append(label, hint);
  input.addEventListener('input', change);
  try { container.append(group); } catch (error) { input.removeEventListener('input', change); throw error; }
  return {
    destroy() {
      disposed = true;
      const errors: unknown[] = [];
      if (!listenerRemoved) try { input.removeEventListener('input', change); listenerRemoved = true; } catch (error) { errors.push(error); }
      if (!elementRemoved) try { group.remove(); elementRemoved = true; } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Zoom control release unconfirmed');
    },
  };
}

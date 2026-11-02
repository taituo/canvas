// Text canvas view: minimal second canvas type.
export function mount(root, ctx) {
  root.innerHTML = '<div class="tv"><textarea spellcheck="false"></textarea></div>';
  const ta = root.querySelector('textarea');
  const doc = ctx.doc;
  ta.value = doc.text;
  let timer = null, dirty = false;
  ta.addEventListener('input', () => {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => { dirty = false; if (ta.value !== doc.text) ctx.submit([{ op: 'setText', text: ta.value }]); }, 400);
  });
  const pull = () => {
    if (dirty) return;
    const a = ta.selectionStart, b = ta.selectionEnd;
    ta.value = doc.text;
    ta.setSelectionRange(a, b);
  };
  ta.focus();
  return { unmount() { clearTimeout(timer); }, reload: pull, remote: pull };
}

const UPDATE_BUTTON_TEXT = 'Atualizar agora';

function removeManualUpdateControls(root = document) {
  for (const element of root.querySelectorAll('button, a')) {
    const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
    if (text !== UPDATE_BUTTON_TEXT) continue;
    element.remove();
  }
}

function scheduleCleanup() {
  window.requestAnimationFrame(() => removeManualUpdateControls());
}

scheduleCleanup();

const observer = new MutationObserver(scheduleCleanup);
observer.observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener('popstate', scheduleCleanup);
window.addEventListener('hashchange', scheduleCleanup);

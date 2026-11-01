/* Keep the print action with Pi's native header when branch navigation rerenders it. */
(() => {
  const header = document.getElementById('header-container');
  function updateHeader() {
    const actions = header?.querySelector('.help-actions');
    if (!actions || actions.querySelector('[data-better-export-print]')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'header-toggle-btn';
    button.dataset.betterExportPrint = 'true';
    button.textContent = 'Print / PDF';
    button.title = 'Print the displayed branch, or save it as a PDF';
    button.addEventListener('click', () => window.print());
    actions.append(button);
    if (document.documentElement.dataset.betterExportConversation) {
      const hint = header.querySelector('.help-hint');
      if (hint) hint.textContent = 'Conversation export · active branch';
    }
  }
  if (header) new MutationObserver(updateHeader).observe(header, { childList: true, subtree: true });
  updateHeader();
})();

/* Runs inside Pi's exported HTML, after marked and before Pi's viewer. */
(() => {
  function mathToken(src, block) {
    const patterns = block
      ? [/^ {0,3}\$\$([^]*?)\$\$(?:[ \t]*\n|[ \t]*$)/, /^ {0,3}\\\[([^]*?)\\\](?:[ \t]*\n|[ \t]*$)/]
      : [/^\$\$([^]*?)\$\$/, /^\\\[([^]*?)\\\]/, /^\\\(([^]*?)\\\)/, /^\$(?!\s|\$)((?:\\[^]|[^$\n\\])+?)\$(?!\d)/];
    for (const [index, pattern] of patterns.entries()) {
      const match = pattern.exec(src);
      if (!match || !match[1].trim() || (!block && index === 3 && /\s$/.test(match[1]))) continue;
      return { type: block ? 'betterMathBlock' : 'betterMathInline', raw: match[0], text: match[1], display: block || index < 2 };
    }
  }
  function escape(value) {
    return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }
  function render(token) {
    const rendered = katex.renderToString(token.text, {
      displayMode: token.display,
      throwOnError: false,
      trust: false,
      strict: 'ignore',
      maxExpand: 1000,
      maxSize: 20,
      output: 'htmlAndMathml',
    });
    const interaction = token.display ? ' data-display="true" role="button" tabindex="0" aria-label="Copy equation as LaTeX" title="Click to copy LaTeX"' : '';
    return `<span class="better-export-math" data-latex="${escape(token.text.trim())}"${interaction}>${rendered}</span>`;
  }

  // Replace selected rendered math with its source, including selections that
  // start or end inside an equation. Leave ordinary browser copying alone.
  document.addEventListener('copy', (event) => {
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !event.clipboardData) return;
    const parts = [];
    let hasMath = false;
    for (let index = 0; index < selection.rangeCount; index++) {
      const range = selection.getRangeAt(index);
      const ancestor = range.commonAncestorContainer;
      const element = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement;
      const equation = element?.closest('.better-export-math');
      if (equation) {
        hasMath = true;
        parts.push(equation.dataset.latex);
      } else {
        const fragment = range.cloneContents();
        const equations = fragment.querySelectorAll('.better-export-math');
        hasMath ||= equations.length > 0;
        equations.forEach((math) => math.replaceWith(document.createTextNode(math.dataset.latex)));
        // innerText retains paragraph breaks in mixed prose/equation selections.
        const container = document.createElement('div');
        container.append(fragment);
        container.style.cssText = 'position:fixed;left:-10000px;white-space:pre-wrap';
        document.body.append(container);
        parts.push(container.innerText ?? container.textContent);
        container.remove();
      }
    }
    if (hasMath) {
      event.clipboardData.setData('text/plain', parts.join('\n'));
      event.preventDefault();
    }
  });

  const status = document.createElement('span');
  status.className = 'better-export-copy-status';
  status.setAttribute('role', 'status');
  document.body.append(status);
  let statusTimer;
  async function copyEquation(equation) {
    try {
      const source = equation.dataset.latex;
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(source);
      } else {
        const input = document.createElement('textarea');
        input.value = source;
        input.style.cssText = 'position:fixed;left:-10000px';
        document.body.append(input);
        try {
          input.select();
          if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
        } finally {
          input.remove();
          equation.focus({ preventScroll: true });
        }
      }
      status.textContent = 'LaTeX copied';
    } catch {
      status.textContent = 'Could not copy. Select the equation and copy it manually.';
    }
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.textContent = ''; }, 3000);
  }
  document.addEventListener('click', (event) => {
    const equation = event.target.closest?.('.better-export-math[data-display]');
    // Selecting part of a formula must not overwrite the clipboard on mouseup.
    if (equation && window.getSelection()?.isCollapsed !== false) void copyEquation(equation);
  });
  document.addEventListener('keydown', (event) => {
    const equation = event.target.closest?.('.better-export-math[data-display]');
    if (equation && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      void copyEquation(equation);
    }
  });
  marked.use({ extensions: [
    {
      name: 'betterMathBlock', level: 'block',
      start(src) { const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(src); return match?.index; },
      tokenizer(src) { return mathToken(src, true); },
      renderer(token) { return render(token) + '\n'; },
    },
    {
      name: 'betterMathInline', level: 'inline',
      start(src) { const match = /\$|\\[([]/.exec(src); return match?.index; },
      tokenizer(src) { return mathToken(src, false); },
      renderer: render,
    },
  ] });
})();

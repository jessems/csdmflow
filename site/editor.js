// The csdmflow editor: a model typed on the left, drawn on the right, with
// examples, a shareable link and downloads. Shared by the landing page
// (index.html) and the standalone editor (editor.html); needs csdmflow.min.js.
(() => {
  // --- editor ------------------------------------------------------------------
  const $ = id => document.getElementById(id);
  const source = $('source'), preview = $('preview'), status = $('status'), picker = $('examples'), gutter = $('gutter');
  const layoutPick = $('layout');
  let examples = [];
  // The standalone page (editor.html) starts on the user's own model; the
  // landing page's editor starts on the first example.
  const standalone = document.body.dataset.page === 'editor';

  // Source travels in the URL hash so a link reproduces the diagram. base64 can
  // hold "+", which a URL reads as a space, so it goes in percent-encoded.
  const encode = s => encodeURIComponent(btoa(String.fromCharCode(...new TextEncoder().encode(s))));
  const decode = s => new TextDecoder().decode(Uint8Array.from(atob(decodeURIComponent(s)), c => c.charCodeAt(0)));
  // The raw value, not URLSearchParams.get, which turns a "+" in older links into a space
  const fromHash = key => (new RegExp(`[#&]${key}=([^&]*)`).exec(location.hash) || [])[1] || null;

  // Your own model, kept in this browser between visits
  const DRAFT = 'csdmflow-draft';
  const STARTER = [
    'title "My service model"',
    '',
    'BA app: My Application',
    'SI app-prod: My Application Prod',
    'BSO app-access: Application Access',
    '',
    'app -> app-prod',
    'app-access -> app-prod',
    '',
  ].join('\n');
  function loadDraft() { try { return localStorage.getItem(DRAFT); } catch { return null; } }
  function saveDraft(text) { try { localStorage.setItem(DRAFT, text); } catch { /* private mode: not kept */ } }

  function paintGutter(badLine) {
    const n = source.value.split('\n').length;
    let html = '';
    for (let i = 1; i <= n; i++) html += `<span${i === badLine ? ' class="bad"' : ''}>${i}</span>`;
    gutter.innerHTML = html;
    gutter.scrollTop = source.scrollTop;
  }
  source.addEventListener('scroll', () => { gutter.scrollTop = source.scrollTop; });

  function setMeta(id, v) { $(id).textContent = v; $(id).title = v; }

  function draw() {
    const text = source.value;
    setMeta('m-title', (/^title\s+"([^"]*)"/m.exec(text) || [])[1] || 'untitled');
    const layout = (/^layout\s+(.+)$/m.exec(text) || [, 'cross'])[1].trim();
    setMeta('m-layout', layout);
    // the layout menu shows the model's layout; "layout reach 1 2" is none of the presets
    const preset = [...layoutPick.options].some(o => o.value === layout && !o.disabled);
    layoutPick.querySelector('[data-custom]').hidden = preset;
    layoutPick.value = preset ? layout : 'custom';
    try {
      const { svg, width, height, warnings } = csdmflow.render(text);
      preview.innerHTML = svg;
      natural = { width, height };
      applyZoom();
      setMeta('m-size', `${Math.round(width)} × ${Math.round(height)}`);
      setMeta('m-boxes', String(csdmflow.scene(text).items.filter(i => i.type === 'node').length));
      status.className = warnings.length ? 'v warn' : 'v';
      setMeta('status', warnings.length ? `${warnings.length} warning${warnings.length > 1 ? 's' : ''}: ${warnings[0]}` : 'OK');
      paintGutter(0);
    } catch (err) {
      status.className = 'v err';
      setMeta('status', 'Error');
      const card = document.createElement('div');
      card.className = 'err-card';
      card.innerHTML = '<b>Can’t draw this yet</b>';
      card.append(err.message);
      preview.replaceChildren(card);
      paintGutter(+((/line (\d+)/.exec(err.message) || [])[1] || 0));
    }
  }

  // after an edit, by typing or by the layout menu: the model is your own now
  function edited() {
    draw();
    history.replaceState(null, '', '#src=' + encode(source.value));
    picker.value = '';
    saveDraft(source.value);
  }

  let timer;
  source.addEventListener('input', () => {
    paintGutter(0);
    clearTimeout(timer);
    timer = setTimeout(edited, 150);
  });

  // The layout lives in the model as a `layout` line, so a link or a download
  // keeps it: the menu rewrites that line, or adds one under the title.
  layoutPick.addEventListener('change', () => {
    const line = 'layout ' + layoutPick.value;
    const text = source.value;
    if (/^[ \t]*layout\b.*$/m.test(text)) source.value = text.replace(/^[ \t]*layout\b.*$/m, line);
    else {
      const lines = text.split('\n');
      let at = 0; // under a leading title and subtitle
      while (at < lines.length && /^\s*(title|subtitle)\b/.test(lines[at])) at++;
      lines.splice(at, 0, line);
      source.value = lines.join('\n');
    }
    paintGutter(0);
    edited();
  });

  picker.addEventListener('change', () => {
    const ex = examples.find(e => e.file === picker.value);
    // back to your own: the model you were writing, or a starting point
    source.value = ex ? ex.source : loadDraft() || STARTER;
    source.scrollTop = 0;
    history.replaceState(null, '', ex ? '#example=' + encodeURIComponent(ex.file) : '#src=' + encode(source.value));
    draw();
  });

  // --- zoom ----------------------------------------------------------------------
  // zoom: null fits the drawing to the pane's width (never above 1:1), a
  // number is the scale. It survives redraws, so typing doesn't reset it.
  const MIN_ZOOM = 0.1, MAX_ZOOM = 8, STEP = 1.25;
  let zoom = null;
  let natural = null; // the drawing's own size, from the last render
  const svgOf = () => preview.querySelector(':scope > svg');

  function fitScale() {
    const cs = getComputedStyle(preview);
    const room = preview.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return natural ? Math.min(1, room / natural.width) : 1;
  }
  const scale = () => (zoom == null ? fitScale() : zoom);

  function applyZoom() {
    const s = scale();
    const svg = svgOf();
    if (svg && natural) {
      svg.style.width = natural.width * s + 'px';
      svg.style.height = natural.height * s + 'px';
    }
    $('zoom-level').textContent = Math.round(s * 100) + '%';
    $('zoom-fit').setAttribute('aria-pressed', String(zoom == null));
    $('zoom-1').setAttribute('aria-pressed', String(zoom === 1));
  }

  // Zoom to `next`, keeping the point at (x, y) on screen where it is, or the
  // middle of the pane when no point is given.
  function zoomTo(next, x, y) {
    const svg = svgOf();
    next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    if (!svg) { zoom = next; return applyZoom(); }
    const pane = preview.getBoundingClientRect();
    if (x == null) { x = pane.left + preview.clientWidth / 2; y = pane.top + preview.clientHeight / 2; }
    const before = svg.getBoundingClientRect();
    const rx = (x - before.left) / before.width, ry = (y - before.top) / before.height;
    zoom = next;
    applyZoom();
    const after = svg.getBoundingClientRect();
    preview.scrollLeft += after.left + rx * after.width - x;
    preview.scrollTop += after.top + ry * after.height - y;
  }

  $('zoom-in').addEventListener('click', () => zoomTo(scale() * STEP));
  $('zoom-out').addEventListener('click', () => zoomTo(scale() / STEP));
  $('zoom-1').addEventListener('click', () => zoomTo(1));
  $('zoom-fit').addEventListener('click', () => { zoom = null; applyZoom(); preview.scrollTo(0, 0); });
  new ResizeObserver(() => { if (zoom == null) applyZoom(); }).observe(preview);

  // The wheel zooms around the pointer; a trackpad pinch arrives as a wheel
  // with ctrlKey. On the landing page the wheel scrolls the page unless
  // ⌘/Ctrl is held, so the diagram doesn't trap the reader.
  preview.addEventListener('wheel', ev => {
    if (!standalone && !ev.ctrlKey && !ev.metaKey) return;
    if (!svgOf()) return;
    ev.preventDefault();
    const px = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY; // lines → pixels
    const factor = Math.min(2, Math.max(0.5, Math.exp(-px * (ev.ctrlKey ? 0.01 : 0.002))));
    zoomTo(scale() * factor, ev.clientX, ev.clientY);
  }, { passive: false });
  preview.title = standalone ? 'Scroll to zoom, drag to move' : '⌘/Ctrl + scroll to zoom, drag to move';

  // Drag to move around a drawing larger than the pane (mouse and pen; touch
  // scrolls natively).
  let drag = null;
  preview.addEventListener('pointerdown', ev => {
    if (ev.pointerType === 'touch' || ev.button !== 0 || !svgOf()) return;
    drag = { x: ev.clientX, y: ev.clientY, left: preview.scrollLeft, top: preview.scrollTop, id: ev.pointerId };
    preview.setPointerCapture(ev.pointerId);
    preview.classList.add('dragging');
    ev.preventDefault();
  });
  preview.addEventListener('pointermove', ev => {
    if (!drag || ev.pointerId !== drag.id) return;
    preview.scrollLeft = drag.left - (ev.clientX - drag.x);
    preview.scrollTop = drag.top - (ev.clientY - drag.y);
  });
  const endDrag = () => { drag = null; preview.classList.remove('dragging'); };
  preview.addEventListener('pointerup', endDrag);
  preview.addEventListener('pointercancel', endDrag);

  function say(text, err) { status.className = err ? 'v err' : 'v'; setMeta('status', text); }

  $('share').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); say('Link copied'); }
    catch { say('Copy the address bar to share'); }
  });

  // --- export ------------------------------------------------------------------
  function current() {
    const sc = csdmflow.scene(source.value);
    const title = (/^title\s+"([^"]*)"/m.exec(source.value) || [])[1] || 'diagram';
    const base = (picker.value || title).replace(/\.csdm$/, '').replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'diagram';
    return { sc, svg: csdmflow.sceneToSvg(sc), title, base };
  }

  function pngBlob(svg, w, h, scale = 2) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = Math.ceil(w * scale); c.height = Math.ceil(h * scale);
        const g = c.getContext('2d');
        g.scale(scale, scale);
        g.drawImage(img, 0, 0, w, h);
        c.toBlob(b => (b ? resolve(b) : reject(new Error('could not draw PNG'))), 'image/png');
      };
      img.onerror = () => reject(new Error('could not load SVG'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  function save(blob, name) {
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const downloads = {
    svg: ({ svg, base }) => save(new Blob([svg], { type: 'image/svg+xml' }), base + '.svg'),
    png: async ({ svg, sc, base }) => save(await pngBlob(svg, sc.width, sc.height), base + '.png'),
    pptx: ({ sc, title, base }) => save(new Blob([csdmflow.toPptx(sc, title)], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), base + '.pptx'),
    drawio: ({ sc, title, base }) => save(new Blob([csdmflow.toDrawio(sc, title)], { type: 'application/vnd.jgraph.mxfile' }), base + '.drawio'),
  };

  // Clipboard writes must start inside the click, so blobs go in as promises.
  const copies = {
    svg: async ({ svg }) => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([svg], { type: 'text/plain' }), 'image/svg+xml': new Blob([svg], { type: 'image/svg+xml' }) })]);
      } catch { await navigator.clipboard.writeText(svg); }
      return 'SVG copied';
    },
    png: async ({ svg, sc }) => {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(svg, sc.width, sc.height) })]);
      return 'PNG copied';
    },
    drawio: async ({ sc }) => {
      await navigator.clipboard.writeText(csdmflow.toDrawioModel(sc));
      return 'Copied: paste onto a draw.io canvas';
    },
  };

  function closeMenus(except) {
    for (const m of document.querySelectorAll('.menu')) {
      if (m === except) continue;
      m.querySelector('.menu-list').hidden = true;
      m.querySelector('[aria-haspopup]').setAttribute('aria-expanded', 'false');
    }
  }
  for (const m of document.querySelectorAll('.menu')) {
    const toggle = m.querySelector('[aria-haspopup]'), list = m.querySelector('.menu-list');
    toggle.addEventListener('click', () => {
      closeMenus(m);
      list.hidden = !list.hidden;
      toggle.setAttribute('aria-expanded', String(!list.hidden));
      if (!list.hidden) list.querySelector('button').focus();
    });
    list.addEventListener('keydown', ev => {
      const items = [...list.querySelectorAll('button')], i = items.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') { items[(i + 1) % items.length].focus(); ev.preventDefault(); }
      if (ev.key === 'ArrowUp') { items[(i - 1 + items.length) % items.length].focus(); ev.preventDefault(); }
      if (ev.key === 'Escape') { closeMenus(); toggle.focus(); }
    });
  }
  document.addEventListener('click', ev => { if (!ev.target.closest('.menu')) closeMenus(); });

  document.addEventListener('click', async ev => {
    const item = ev.target.closest('[data-download], [data-copy]');
    if (!item) return;
    closeMenus();
    let cur;
    try { cur = current(); } catch (err) { return say('Fix the error first', true); }
    try {
      if (item.dataset.download) { await downloads[item.dataset.download](cur); say('Downloaded .' + item.dataset.download); }
      else say(await copies[item.dataset.copy](cur));
    } catch (err) {
      say('Could not ' + (item.dataset.download ? 'download' : 'copy') + ': ' + err.message, true);
    }
  });

  // --- start ---------------------------------------------------------------------
  function pretty(file) {
    return file.replace(/\.csdm$/, '').replace(/^slide-(\d+)-/, 'Slide $1 · ').replace(/-/g, ' ');
  }

  fetch('examples.json')
    .then(r => r.json())
    .then(list => {
      examples = list;
      picker.innerHTML = '<option value="">— your own —</option>' +
        list.map(e => `<option value="${e.file}">${pretty(e.file)}</option>`).join('');
      const src = fromHash('src');
      const exFile = fromHash('example') && decodeURIComponent(fromHash('example'));
      const ex = list.find(e => e.file === exFile);
      let own = null;
      if (src) {
        try { own = decode(src); } catch { /* a broken link: start as if there were none */ }
      }
      if (own == null && !ex && standalone) own = loadDraft() || STARTER;
      if (own != null) {
        source.value = own;
        picker.value = '';
      } else {
        source.value = (ex || list[0]).source;
        picker.value = (ex || list[0]).file;
      }
      draw();
      // a shared link opens on the landing page's editor
      if (!standalone && (src || exFile)) $('workbench').scrollIntoView({ behavior: 'instant' });
    })
    .catch(err => say('Could not load examples: ' + err.message, true));
})();

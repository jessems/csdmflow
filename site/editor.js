// The csdmflow editor: a model typed on the left, drawn on the right, with
// examples, a shareable link and downloads. Shared by the landing page
// (index.html) and the standalone editor (editor.html); needs csdmflow.min.js.
(() => {
  // --- editor ------------------------------------------------------------------
  const $ = id => document.getElementById(id);
  const source = $('source'), preview = $('preview'), status = $('status'), picker = $('examples'), gutter = $('gutter');
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
    setMeta('m-layout', (/^layout\s+(.+)$/m.exec(text) || [, 'cross'])[1].trim());
    try {
      const { svg, width, height, warnings } = csdmflow.render(text);
      preview.innerHTML = svg;
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

  let timer;
  source.addEventListener('input', () => {
    paintGutter(0);
    clearTimeout(timer);
    timer = setTimeout(() => {
      draw();
      history.replaceState(null, '', '#src=' + encode(source.value));
      picker.value = '';
      saveDraft(source.value);
    }, 150);
  });

  picker.addEventListener('change', () => {
    const ex = examples.find(e => e.file === picker.value);
    // back to your own: the model you were writing, or a starting point
    source.value = ex ? ex.source : loadDraft() || STARTER;
    source.scrollTop = 0;
    history.replaceState(null, '', ex ? '#example=' + encodeURIComponent(ex.file) : '#src=' + encode(source.value));
    draw();
  });

  for (const [id, fit] of [['zoom-fit', true], ['zoom-1', false]]) {
    $(id).addEventListener('click', () => {
      preview.classList.toggle('fit', fit);
      $('zoom-fit').setAttribute('aria-pressed', String(fit));
      $('zoom-1').setAttribute('aria-pressed', String(!fit));
    });
  }

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

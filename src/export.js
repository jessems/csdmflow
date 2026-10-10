'use strict';

// Exporters: turn a scene from gridflow's buildScene() into editable shapes.
//
//   toDrawio(scene)      → draw.io file (<mxfile>) as a string
//   toDrawioModel(scene) → bare <mxGraphModel>, what draw.io accepts on paste
//   toPptx(scene)        → .pptx bytes (Uint8Array): one slide sized to the
//                          diagram, everything in one group
//
// Boxes become real shapes with their text inside, lines become freeforms
// (PowerPoint) or edges glued to the boxes they touch (draw.io), labels become
// text boxes. No dependencies; runs in Node and the browser.

const FONT = 'Arial';

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const r1 = n => Math.round(n * 10) / 10;

// --- geometry shared by both exporters ---------------------------------------

// Approximate advance of a string in Arial, in ems.
function textWidth(s, bold) {
  let w = 0;
  for (const ch of s) {
    if (/[ijlI.,:;'|!]/.test(ch)) w += 0.28;
    else if (/[ frt()\-]/.test(ch)) w += 0.36;
    else if (/[mwMW@]/.test(ch)) w += 0.86;
    else if (/[A-Z]/.test(ch)) w += 0.68;
    else w += 0.56;
  }
  return w * (bold ? 1.06 : 1);
}

// Box for a text item: svg text is positioned by baseline and anchor.
function textBox(t) {
  const bold = (t.weight || 400) >= 600;
  const w = Math.max(...t.lines.map(s => textWidth(s, bold))) * t.size + 4;
  const gap = t.lineGap || t.size * 1.2;
  const h = t.size * 1.25 + (t.lines.length - 1) * gap;
  const x = t.anchor === 'middle' ? t.x - w / 2 : t.anchor === 'end' ? t.x - w : t.x;
  const y = t.y - t.size * 0.95;
  if (!t.rotate) return { x, y, w, h, rot: 0 };
  // svg rotates 90° about the anchor point; shapes rotate about their centre
  const cx = x + w / 2 - t.x, cy = y + h / 2 - t.y;
  const rcx = t.x - cy, rcy = t.y + cx;
  return { x: rcx - w / 2, y: rcy - h / 2, w, h, rot: 90 };
}

function hex(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(c || '');
  if (m) return m[1].toUpperCase();
  const s = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c || '');
  if (s) return (s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toUpperCase();
  return null;
}

// Colour of the background gradient at (x, y), so label backgrounds blend in.
function bgAt(scene, x, y) {
  const bg = scene.items.find(i => i.type === 'background');
  if (!bg) return null;
  const a = hex(bg.from), b = hex(bg.to);
  if (!a || !b) return a || b;
  // the svg gradient runs from (0,0) to (0.35, 1) in the box's own units
  const u = x / bg.w, v = y / bg.h;
  const t = Math.max(0, Math.min(1, (u * 0.35 + v) / (0.35 * 0.35 + 1)));
  const mix = sh => Math.round(((parseInt(a, 16) >> sh) & 255) * (1 - t) + ((parseInt(b, 16) >> sh) & 255) * t);
  return [16, 8, 0].map(sh => mix(sh).toString(16).padStart(2, '0')).join('').toUpperCase();
}

// The node whose border a line end touches, with the touch point as 0..1 fractions.
function attach(scene, p) {
  for (const n of scene.items) {
    if (n.type !== 'node') continue;
    const inX = p.x >= n.x - 1.5 && p.x <= n.x + n.w + 1.5;
    const inY = p.y >= n.y - 1.5 && p.y <= n.y + n.h + 1.5;
    const onV = Math.abs(p.x - n.x) < 1.5 || Math.abs(p.x - n.x - n.w) < 1.5;
    const onH = Math.abs(p.y - n.y) < 1.5 || Math.abs(p.y - n.y - n.h) < 1.5;
    if (inX && inY && (onV || onH)) {
      const fx = Math.max(0, Math.min(1, (p.x - n.x) / n.w));
      const fy = Math.max(0, Math.min(1, (p.y - n.y) / n.h));
      return { node: n, fx: r1(fx * 1000) / 1000, fy: r1(fy * 1000) / 1000 };
    }
  }
  return null;
}

// --- draw.io -----------------------------------------------------------------

const DRAWIO_DASH = { dash: '3 2', dashdot: '4.5 2 1 2' }; // in line widths

function drawioCells(scene) {
  const cells = [];
  let seq = 0;
  const id = () => 'c' + (++seq);
  const ids = new Map();
  const geo = (x, y, w, h) => `<mxGeometry x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" as="geometry"/>`;
  const vertex = (value, style, x, y, w, h) => {
    const cid = id();
    cells.push(`<mxCell id="${cid}" value="${xml(value)}" style="${style}" vertex="1" parent="1">${geo(x, y, w, h)}</mxCell>`);
    return cid;
  };
  const color = c => (c === 'none' || !c ? 'none' : '#' + (hex(c) || '000000'));

  for (const it of scene.items) {
    if (it.type === 'background') {
      vertex('', `rounded=0;whiteSpace=wrap;html=1;fillColor=${color(it.from)};gradientColor=${color(it.to)};gradientDirection=south;strokeColor=none;locked=1;`, 0, 0, it.w, it.h);
    } else if (it.type === 'rect') {
      const round = it.rx ? `rounded=1;absoluteArcSize=1;arcSize=${it.rx * 2};` : 'rounded=0;';
      vertex('', `${round}whiteSpace=wrap;html=1;fillColor=${color(it.fill)};strokeColor=${it.stroke ? color(it.stroke) : 'none'};strokeWidth=${it.sw || 1};`, it.x, it.y, it.w, it.h);
    } else if (it.type === 'node') {
      const html = it.rows.map(r => r.weight >= 600 ? `<b>${xml(r.text)}</b>` : xml(r.text)).join('<br>');
      const style = `rounded=1;absoluteArcSize=1;arcSize=${it.rx * 2};whiteSpace=wrap;html=1;fillColor=${color(it.fill)};strokeColor=${color(it.stroke)};strokeWidth=${it.sw};fontColor=${color(it.textColor)};fontSize=${r1(it.size)};fontFamily=${FONT};spacing=2;`;
      ids.set(it, vertex(html, style, it.x, it.y, it.w, it.h));
    } else if (it.type === 'text') {
      const b = textBox(it);
      const align = it.anchor === 'middle' ? 'center' : it.anchor === 'end' ? 'right' : 'left';
      const halo = it.halo ? `labelBackgroundColor=#${bgAt(scene, it.x, it.y) || hex(it.halo) || 'FFFFFF'};` : '';
      const style = `text;html=1;align=${align};verticalAlign=top;whiteSpace=nowrap;spacing=0;fontSize=${r1(it.size)};fontFamily=${FONT};fontColor=${color(it.fill)};` +
        `${(it.weight || 400) >= 600 ? 'fontStyle=1;' : ''}${halo}${b.rot ? `rotation=${b.rot};` : ''}`;
      vertex(it.lines.map(xml).join('<br>'), style, b.x, b.y, b.w, b.h);
    } else if (it.type === 'circle') {
      vertex('', `ellipse;html=1;fillColor=${color(it.fill)};strokeColor=none;`, it.cx - it.r, it.cy - it.r, it.r * 2, it.r * 2);
    } else if (it.type === 'path') {
      const pts = it.points;
      const a = it.role === 'edge' ? attach(scene, pts[0]) : null;
      const z = it.role === 'edge' ? attach(scene, pts[pts.length - 1]) : null;
      let style = `edgeStyle=none;html=1;rounded=0;strokeColor=${color(it.color)};strokeWidth=${it.sw};` +
        `endArrow=${it.arrowEnd ? 'block;endFill=1;endSize=5' : 'none'};startArrow=${it.arrowStart ? 'block;startFill=1;startSize=5' : 'none'};`;
      if (it.dash) style += `dashed=1;dashPattern=${DRAWIO_DASH[it.dash] || DRAWIO_DASH.dash};`;
      if (a) style += `exitX=${a.fx};exitY=${a.fy};exitDx=0;exitDy=0;exitPerimeter=0;`;
      if (z) style += `entryX=${z.fx};entryY=${z.fy};entryDx=0;entryDy=0;entryPerimeter=0;`;
      const mid = pts.slice(1, -1).map(p => `<mxPoint x="${r1(p.x)}" y="${r1(p.y)}"/>`).join('');
      // edges come before the boxes they glue to: keep their place, write them
      // once every box has an id
      cells.push({ style, mid, first: pts[0], last: pts[pts.length - 1], a, z });
    }
  }
  return cells.map(c => {
    if (typeof c === 'string') return c;
    const ends = (c.a ? ` source="${ids.get(c.a.node)}"` : '') + (c.z ? ` target="${ids.get(c.z.node)}"` : '');
    return `<mxCell id="${id()}" style="${c.style}" edge="1" parent="1"${ends}><mxGeometry relative="1" as="geometry">` +
      `<mxPoint x="${r1(c.first.x)}" y="${r1(c.first.y)}" as="sourcePoint"/><mxPoint x="${r1(c.last.x)}" y="${r1(c.last.y)}" as="targetPoint"/>` +
      (c.mid ? `<Array as="points">${c.mid}</Array>` : '') + '</mxGeometry></mxCell>';
  });
}

function toDrawioModel(scene) {
  const bg = scene.items.find(i => i.type === 'background');
  return `<mxGraphModel dx="0" dy="0" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" ` +
    `pageWidth="${Math.ceil(scene.width)}" pageHeight="${Math.ceil(scene.height)}"${bg ? ` background="#${hex(bg.from) || 'FFFFFF'}"` : ''} math="0" shadow="0">` +
    `<root><mxCell id="0"/><mxCell id="1" parent="0"/>${drawioCells(scene).join('')}</root></mxGraphModel>`;
}

function toDrawio(scene, name = 'Diagram') {
  return `<mxfile host="csdmflow"><diagram id="csdmflow" name="${xml(name)}">${toDrawioModel(scene)}</diagram></mxfile>\n`;
}

// --- PowerPoint ----------------------------------------------------------------

const EMU = 9525; // per px at 96 dpi
const e = px => Math.round(px * EMU);
const pt100 = px => Math.round(px * 0.75 * 100); // px font size → hundredths of a point
const PPTX_DASH = { dash: [[3, 2]], dashdot: [[4.5, 2], [1, 2]] }; // in line widths

function solid(c) {
  const h = hex(c);
  return h ? `<a:solidFill><a:srgbClr val="${h}"/></a:solidFill>` : '<a:noFill/>';
}

function pptxShapes(scene) {
  const out = [];
  let seq = 2;
  const nv = (name, txBox) => `<p:nvSpPr><p:cNvPr id="${++seq}" name="${xml(name)} ${seq}"/><p:cNvSpPr${txBox ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr>`;
  const xfrm = (x, y, w, h, rot) => `<a:xfrm${rot ? ` rot="${rot * 60000}"` : ''}><a:off x="${e(x)}" y="${e(y)}"/><a:ext cx="${Math.max(1, e(w))}" cy="${Math.max(1, e(h))}"/></a:xfrm>`;
  const geom = (w, h, rx) => rx
    ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.round(rx / Math.min(w, h) * 100000)}"/></a:avLst></a:prstGeom>`
    : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  const line = (c, sw) => (c && c !== 'none' ? `<a:ln w="${e(sw || 1)}">${solid(c)}</a:ln>` : '<a:ln><a:noFill/></a:ln>');
  const run = (text, size, weight, color) =>
    `<a:r><a:rPr lang="en-US" sz="${pt100(size)}"${weight >= 600 ? ' b="1"' : ''} dirty="0">${solid(color)}<a:latin typeface="${FONT}"/><a:cs typeface="${FONT}"/></a:rPr><a:t>${xml(text)}</a:t></a:r>`;
  const body = (paras, algn, anchor, lineH) =>
    `<p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>` +
    paras.map(p => `<a:p><a:pPr algn="${algn}">${lineH ? `<a:lnSpc><a:spcPts val="${Math.round(lineH * 75)}"/></a:lnSpc>` : ''}</a:pPr>${p}</a:p>`).join('') + '</p:txBody>';

  for (const it of scene.items) {
    if (it.type === 'background') {
      // svg: (0,0) → (0.35, 1) in the box's own units; scaled="1" means the same here
      const ang = Math.round(Math.atan2(1, 0.35) * 180 / Math.PI * 60000);
      out.push(`<p:sp>${nv('Background')}<p:spPr>${xfrm(0, 0, it.w, it.h)}${geom(it.w, it.h)}` +
        `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="${hex(it.from) || 'FFFFFF'}"/></a:gs><a:gs pos="100000"><a:srgbClr val="${hex(it.to) || 'FFFFFF'}"/></a:gs></a:gsLst><a:lin ang="${ang}" scaled="1"/></a:gradFill>` +
        `<a:ln><a:noFill/></a:ln></p:spPr></p:sp>`);
    } else if (it.type === 'rect') {
      out.push(`<p:sp>${nv('Rectangle')}<p:spPr>${xfrm(it.x, it.y, it.w, it.h)}${geom(it.w, it.h, it.rx)}${it.fill === 'none' ? '<a:noFill/>' : solid(it.fill)}${line(it.stroke, it.sw)}</p:spPr></p:sp>`);
    } else if (it.type === 'node') {
      const paras = it.rows.map(r => run(r.text, it.size, r.weight, it.textColor));
      out.push(`<p:sp>${nv(it.rows.map(r => r.text).join(' '))}<p:spPr>${xfrm(it.x, it.y, it.w, it.h)}${geom(it.w, it.h, it.rx)}${solid(it.fill)}${line(it.stroke, it.sw)}</p:spPr>` +
        body(paras, 'ctr', 'ctr', it.lineH) + '</p:sp>');
    } else if (it.type === 'text') {
      const b = textBox(it);
      const algn = it.anchor === 'middle' ? 'ctr' : it.anchor === 'end' ? 'r' : 'l';
      const fill = it.halo ? solid(bgAt(scene, it.x, it.y) || it.halo) : '<a:noFill/>';
      const paras = it.lines.map(s => run(s, it.size, it.weight || 400, it.fill));
      out.push(`<p:sp>${nv('Text', true)}<p:spPr>${xfrm(b.x, b.y, b.w, b.h, b.rot)}${geom(b.w, b.h)}${fill}<a:ln><a:noFill/></a:ln></p:spPr>` +
        body(paras, algn, 't', it.lineGap) + '</p:sp>');
    } else if (it.type === 'circle') {
      out.push(`<p:sp>${nv('Joint')}<p:spPr>${xfrm(it.cx - it.r, it.cy - it.r, it.r * 2, it.r * 2)}<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>${solid(it.fill)}<a:ln><a:noFill/></a:ln></p:spPr></p:sp>`);
    } else if (it.type === 'path') {
      const xs = it.points.map(p => p.x), ys = it.points.map(p => p.y);
      const x0 = Math.min(...xs), y0 = Math.min(...ys);
      const w = Math.max(...xs) - x0, h = Math.max(...ys) - y0;
      const cmds = it.points.map((p, i) => `<a:${i ? 'lnTo' : 'moveTo'}><a:pt x="${e(p.x - x0)}" y="${e(p.y - y0)}"/></a:${i ? 'lnTo' : 'moveTo'}>`).join('');
      const dash = it.dash ? `<a:custDash>${(PPTX_DASH[it.dash] || PPTX_DASH.dash).map(([d, s]) => `<a:ds d="${d * 100000}" sp="${s * 100000}"/>`).join('')}</a:custDash>` : '';
      const head = it.arrowStart ? '<a:headEnd type="triangle" w="med" len="med"/>' : '';
      const tail = it.arrowEnd ? '<a:tailEnd type="triangle" w="med" len="med"/>' : '';
      out.push(`<p:sp>${nv(it.role === 'key' ? 'Key line' : 'Line')}<p:spPr>${xfrm(x0, y0, w, h)}` +
        `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${Math.max(1, e(w))}" h="${Math.max(1, e(h))}" fill="none">${cmds}</a:path></a:pathLst></a:custGeom>` +
        `<a:noFill/><a:ln w="${e(it.sw)}">${solid(it.color)}${dash}<a:round/>${head}${tail}</a:ln></p:spPr></p:sp>`);
    }
  }
  return out;
}

function toPptx(scene, title = 'csdmflow diagram') {
  const W = Math.max(914400, e(scene.width)), H = Math.max(914400, e(scene.height));
  const shapes = pptxShapes(scene);
  const ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const hdr = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const rels = list => hdr + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    list.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('') + '</Relationships>';
  const emptyTree = '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>';
  const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="2" name="${xml(title)}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${e(scene.width)}" cy="${e(scene.height)}"/><a:chOff x="0" y="0"/><a:chExt cx="${e(scene.width)}" cy="${e(scene.height)}"/></a:xfrm></p:grpSpPr>` +
    shapes.join('') + '</p:grpSp>';

  const files = {
    '[Content_Types].xml': hdr + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '</Types>',
    '_rels/.rels': hdr + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '</Relationships>',
    'docProps/core.xml': hdr + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      `<dc:title>${xml(title)}</dc:title><dc:creator>csdmflow</dc:creator></cp:coreProperties>`,
    'ppt/presentation.xml': hdr + `<p:presentation ${ns} saveSubsetFonts="1">` +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
      `<p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'slide', 'slides/slide1.xml'], ['rId3', 'theme', 'theme/theme1.xml']]),
    'ppt/slides/slide1.xml': hdr + `<p:sld ${ns}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    'ppt/slides/_rels/slide1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml': hdr + `<p:sldLayout ${ns} preserve="1">${emptyTree.replace('<p:cSld>', '<p:cSld name="Blank">')}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/slideMasters/slideMaster1.xml': hdr + `<p:sldMaster ${ns}>${emptyTree}` +
      '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
      '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>',
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]),
    'ppt/theme/theme1.xml': hdr + THEME,
  };
  return zip(files);
}

const THEME = '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="csdmflow"><a:themeElements>' +
  '<a:clrScheme name="csdmflow"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="5BC0D0"/></a:accent1><a:accent2><a:srgbClr val="F2AE45"/></a:accent2><a:accent3><a:srgbClr val="6CC067"/></a:accent3><a:accent4><a:srgbClr val="B98E4A"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="4A90D9"/></a:accent5><a:accent6><a:srgbClr val="9B6CD9"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
  `<a:fontScheme name="csdmflow"><a:majorFont><a:latin typeface="${FONT}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${FONT}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
  '<a:fmtScheme name="csdmflow"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="28575"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>' +
  '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

// --- minimal zip (stored, no compression) ---------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameB = enc.encode(name);
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true); local.setUint16(10, 0, true); local.setUint16(12, 0x21, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, nameB.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameB, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true); cen.setUint16(12, 0, true); cen.setUint16(14, 0x21, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
    cen.setUint16(28, nameB.length, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cenSize = central.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true); end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
  let p = 0;
  for (const b of all) { out.set(b, p); p += b.length; }
  return out;
}

module.exports = { toDrawio, toDrawioModel, toPptx };

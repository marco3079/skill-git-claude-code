(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const ui = {
    selected: saved.selected || null,
    showManual: saved.showManual !== false,
    showEmpty: !!saved.showEmpty,
    query: '',
    expanded: {},
  };
  let S = null;
  let rowsCache = [];
  const ROW_H = 60;
  const PALETTE = ['#8b7cf6', '#3ba7ff', '#22c08b', '#f2a33a', '#ec5f9b', '#00b8c4', '#f0743c', '#6f8cff'];
  const app = document.getElementById('app');

  const svg = (d, size = 14) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const I = {
    history: svg('<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v2.6h2.6"/><path d="M8 5v3.2l2 1.3"/>', 16),
    undo: svg('<path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7"/>'),
    redo: svg('<path d="m10.5 3.5 3 3-3 3"/><path d="M13.5 6.5h-7a3.5 3.5 0 0 0 0 7H9"/>'),
    diff: svg('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M8 2.5v11"/><path d="M4.2 6.5h2M5.2 5.5v2M9.8 6.5h2"/>'),
    open: svg('<path d="M9 2.5h4.5V7"/><path d="M13.5 2.5 7.5 8.5"/><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/>'),
    copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>', 12),
    popout: svg('<rect x="2.5" y="4.5" width="9" height="9" rx="1.5"/><path d="M6.5 2.5h7v7"/>'),
    search: svg('<circle cx="7" cy="7" r="4.5"/><path d="m13.5 13.5-3.2-3.2"/>', 13),
    patch: svg('<path d="M9.5 2.5H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6z"/><path d="M9.5 2.5V6H13"/><path d="M6 9h4M8 7v4"/>'),
    check: svg('<path d="m3.5 8.5 3 3 6-7"/>', 11),
    commit: svg('<circle cx="8" cy="8" r="2.6"/><path d="M1.5 8h3.9M10.6 8h3.9"/>', 30),
    arrow: svg('<path d="M3 8h10M9 4l4 4-4 4"/>', 12),
    pencil: svg('<path d="M10.5 2.5 13.5 5.5 6 13H3v-3z"/>', 11),
  };

  // -------------------------------------------------------------------------
  // utilidades

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function ago(iso) {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 45) return 'agora';
    if (s < 3600) return `há ${Math.round(s / 60)} min`;
    if (s < 86400) return `há ${Math.round(s / 3600)} h`;
    if (s < 172800) return 'ontem';
    if (s < 7 * 86400) return `há ${Math.round(s / 86400)} dias`;
    return new Date(iso).toLocaleDateString('pt-BR');
  }
  function when(iso) {
    return iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  }
  function dur(a, b) {
    if (!a || !b) return '';
    const s = Math.round((Date.parse(b) - Date.parse(a)) / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} min ${s % 60 ? (s % 60) + ' s' : ''}`.trim() : `${Math.floor(m / 60)} h ${m % 60} min`;
  }
  function num(n) { return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n || 0); }
  function short(sha) { return sha ? sha.slice(0, 7) : ''; }
  function persist() { vscode.setState({ selected: ui.selected, showManual: ui.showManual, showEmpty: ui.showEmpty }); }

  function sessionColors() {
    const map = new Map();
    for (const e of (S && S.entries) || []) {
      if (e.sessionId && !map.has(e.sessionId)) map.set(e.sessionId, PALETTE[map.size % PALETTE.length]);
    }
    return map;
  }
  function entryById(id) { return S && S.entries ? S.entries.find(e => e.id === id) : null; }

  function titleOf(e) {
    switch (e.kind) {
      case 'request': return e.title || 'Requisição';
      case 'manual': return 'Alterações fora do Claude' + (e.note ? ` · ${e.note}` : '');
      case 'undo': { const t = entryById(e.target); return `Desfez #${e.seq}${t ? ' · ' + t.title : ''}`; }
      case 'redo': { const t = entryById(e.target); return `Refez #${e.seq}${t ? ' · ' + t.title : ''}`; }
      default: return 'Estado inicial do projeto';
    }
  }

  // markdown simples (texto já escapado antes de qualquer marcação)
  function inline(t) {
    return esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  }
  function md(src) {
    const blocks = [];
    const text = String(src || '').replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
      blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    const out = [];
    let list = null;
    let para = [];
    let table = null;
    const flush = () => {
      if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; }
      if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; }
      if (table) { out.push(`<table>${table.map((r, i) => `<tr>${r.map(c => i ? `<td>${inline(c)}</td>` : `<th>${inline(c)}</th>`).join('')}</tr>`).join('')}</table>`); table = null; }
    };
    for (const line of text.split('\n')) {
      let m;
      if ((m = /^\u0000(\d+)\u0000$/.exec(line.trim()))) { flush(); out.push(blocks[Number(m[1])]); }
      else if ((m = /^\s*#{1,6}\s+(.*)$/.exec(line))) { flush(); out.push(`<h4>${inline(m[1])}</h4>`); }
      else if ((m = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line))) {
        if (para.length || table) { const l = list; list = null; flush(); list = l; }
        const tag = m[2] ? 'ol' : 'ul';
        if (!list || list.tag !== tag) { flush(); list = { tag, items: [] }; }
        list.items.push(m[3]);
      } else if (/^\s*\|.*\|\s*$/.test(line)) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
        if (!table) { flush(); table = []; }
        table.push(line.trim().slice(1, -1).split('|').map(c => c.trim()));
      } else if (!line.trim()) { flush(); }
      else { if (list || table) flush(); para.push(line); }
    }
    flush();
    return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  }

  // -------------------------------------------------------------------------
  // dados

  function visibleEntries() {
    if (!S || !S.entries) return [];
    const q = ui.query.trim().toLowerCase();
    return S.entries.filter(e => {
      if (e.kind === 'manual' && !ui.showManual) return false;
      if (e.kind === 'request' && !e.commit && e.status !== 'open' && !ui.showEmpty) return false;
      if (q) {
        const hay = [titleOf(e), e.seq != null ? '#' + e.seq : '', e.commit || '',
          ...(e.prompts || []).map(p => p.text), ...(e.files || []).map(f => f.p)].join('\n').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).slice().reverse();
  }

  // -------------------------------------------------------------------------
  // estrutura fixa (o campo de busca não é recriado a cada atualização)

  function shell() {
    app.innerHTML = `
      <div class="top">
        <div class="brand">
          <div class="brand-icon">${I.history}</div>
          <div>
            <h1>Histórico de requisições</h1>
            <div class="sub" id="projectLine"></div>
          </div>
        </div>
        <div class="spacer"></div>
        <div class="actions" id="topActions"></div>
      </div>
      <div class="bar">
        <div class="stats" id="stats"></div>
        <button class="toggle" data-act="toggleManual" id="tManual" title="Mostrar edições feitas fora do Claude"><span class="dot"></span>Edições manuais</button>
        <button class="toggle" data-act="toggleEmpty" id="tEmpty" title="Mostrar requisições que não alteraram arquivos"><span class="dot"></span>Sem alterações</button>
        <label class="search">${I.search}<input id="q" placeholder="Buscar pedido, arquivo ou hash…" spellcheck="false"></label>
      </div>
      <div class="body" id="body">
        <div class="list-wrap" id="listWrap" tabindex="0"><div class="list" id="list"></div></div>
        <div class="detail" id="detail"></div>
      </div>
      <div class="busy" id="busy"><div class="spinner"></div></div>`;
    const q = document.getElementById('q');
    q.addEventListener('input', () => { ui.query = q.value; renderList(); renderDetail(); });
  }

  function render() {
    if (!document.getElementById('body')) shell();
    renderTop();
    const body = document.getElementById('body');
    if (!S || S.empty || S.disabled) {
      body.style.display = 'block';
      body.innerHTML = emptyState();
      return;
    }
    if (!document.getElementById('listWrap')) {
      body.innerHTML = '<div class="list-wrap" id="listWrap" tabindex="0"><div class="list" id="list"></div></div><div class="detail" id="detail"></div>';
    }
    body.style.display = '';
    renderList();
    renderDetail();
  }

  function emptyState() {
    if (S && S.disabled) {
      return `<div class="empty-state"><div><div class="big">${I.history}</div><h2>Histórico desativado neste projeto</h2><p>${esc(S.disabled)}</p></div></div>`;
    }
    return `<div class="empty-state"><div>
      <div class="big">${I.commit}</div>
      <h2>Nenhuma requisição registrada ainda</h2>
      <p>Mande uma mensagem para o Claude Code nesta pasta. Cada pedido vira um commit com o plano e os arquivos alterados.</p>
      <p>Se nada aparecer, confira se o plugin está instalado: <code>/plugin</code> → <code>historico</code>.</p>
    </div></div>`;
  }

  function renderTop() {
    const line = document.getElementById('projectLine');
    const actions = document.getElementById('topActions');
    const stats = document.getElementById('stats');
    document.getElementById('tManual').classList.toggle('on', ui.showManual);
    document.getElementById('tEmpty').classList.toggle('on', ui.showEmpty);
    if (!S) { line.textContent = 'carregando…'; return; }
    const projects = S.projects || [];
    if (projects.length > 1) {
      line.innerHTML = `<select id="proj">${projects.map(p => `<option value="${esc(p.key)}" ${p.key === S.key ? 'selected' : ''}>${esc(p.name)} — ${esc(p.project)}</option>`).join('')}</select>`;
      document.getElementById('proj').addEventListener('change', ev => vscode.postMessage({ type: 'selectProject', key: ev.target.value }));
    } else {
      line.innerHTML = `<span title="${esc(S.project || S.folder || '')}">${esc(S.name || 'sem projeto')}</span>`;
    }
    const u = S.targets && entryById(S.targets.undo);
    const r = S.targets && entryById(S.targets.redo);
    actions.innerHTML = `
      <button class="btn danger" data-act="undo" ${u && !S.running ? '' : 'disabled'} title="${u ? esc('Desfazer: ' + u.title) : 'Nada para desfazer'}">${I.undo}Desfazer${u ? ` <span class="k">#${u.seq}</span>` : ''}</button>
      <button class="btn good" data-act="redo" ${r && !S.running ? '' : 'disabled'} title="${r ? esc('Refazer: ' + r.title) : 'Nada para refazer'}">${I.redo}Refazer${r ? ` <span class="k">#${r.seq}</span>` : ''}</button>
      <button class="icon-btn" data-act="popout" title="Abrir em janela flutuante">${I.popout}</button>`;
    if (!S.entries) { stats.innerHTML = ''; return; }
    const reqs = S.entries.filter(e => e.kind === 'request');
    const applied = reqs.filter(e => e.status === 'done' && e.commit);
    const files = new Set();
    applied.forEach(e => (e.files || []).forEach(f => files.add(f.p)));
    const sessions = new Set(reqs.map(e => e.sessionId));
    const add = applied.reduce((s, e) => s + (e.add || 0), 0);
    const del = applied.reduce((s, e) => s + (e.del || 0), 0);
    stats.innerHTML = `<span><b>${reqs.length}</b> requisições</span><span><b>${sessions.size}</b> sessões</span>
      <span><b>${files.size}</b> arquivos</span><span><b class="add">+${num(add)}</b> <b class="del">−${num(del)}</b></span>`;
  }

  // -------------------------------------------------------------------------
  // lista + grafo

  function nodeSvg(e, x, y, colors) {
    const c = colors.get(e.sessionId) || 'var(--accent)';
    if (e.kind === 'request') {
      if (e.status === 'open') {
        return `<circle class="ping" cx="${x}" cy="${y}" r="6" fill="none" style="stroke:var(--warn)" stroke-width="2"/>
                <circle cx="${x}" cy="${y}" r="6" style="fill:var(--warn);stroke:var(--bg)" stroke-width="2.5"/>`;
      }
      if (!e.commit) return `<circle cx="${x}" cy="${y}" r="3.5" style="fill:var(--bg);stroke:${c}" stroke-width="1.5"/>`;
      if (e.status === 'undone') return `<circle cx="${x}" cy="${y}" r="6" style="fill:var(--bg);stroke:var(--del)" stroke-width="2" stroke-dasharray="2.4 2"/>`;
      if (e.status === 'discarded') return `<circle cx="${x}" cy="${y}" r="5.5" style="fill:var(--bg);stroke:var(--muted)" stroke-width="1.5"/>`;
      return `<circle cx="${x}" cy="${y}" r="7" style="fill:${c};stroke:var(--bg)" stroke-width="2.5"/>`;
    }
    if (e.kind === 'manual') return `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" transform="rotate(45 ${x} ${y})" style="fill:var(--bg);stroke:var(--muted)" stroke-width="1.5"/>`;
    if (e.kind === 'undo') return `<circle cx="${x}" cy="${y}" r="4.5" style="fill:var(--bg);stroke:var(--del)" stroke-width="2"/>`;
    if (e.kind === 'redo') return `<circle cx="${x}" cy="${y}" r="4.5" style="fill:var(--bg);stroke:var(--add)" stroke-width="2"/>`;
    return `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" rx="2.5" style="fill:var(--muted)"/>`;
  }

  function graph(rows, colors) {
    const X0 = 20;
    const LANE = 11;
    const pos = new Map(rows.map((e, i) => [e.id, i]));
    const y = i => i * ROW_H + ROW_H / 2;
    // arcos tracejados ligando cada desfazer/refazer à requisição que ele afetou
    const arcs = [];
    rows.forEach((e, i) => {
      if ((e.kind === 'undo' || e.kind === 'redo') && pos.has(e.target)) arcs.push({ from: i, to: pos.get(e.target), kind: e.kind });
    });
    const lanes = [];
    for (const a of arcs) {
      let l = 0;
      while (lanes[l] && lanes[l].some(([lo, hi]) => !(a.to < lo || a.from > hi))) l++;
      (lanes[l] = lanes[l] || []).push([a.from, a.to]);
      a.lane = l + 1;
    }
    const width = X0 + lanes.length * LANE + 16;
    const height = Math.max(rows.length * ROW_H, 1);
    const parts = [];
    if (rows.length > 1) {
      parts.push(`<line x1="${X0}" y1="${y(0)}" x2="${X0}" y2="${y(rows.length - 1)}" style="stroke:color-mix(in srgb, var(--fg) 22%, transparent)" stroke-width="2"/>`);
    }
    for (const a of arcs) {
      const xl = X0 + a.lane * LANE;
      const y1 = y(a.from);
      const y2 = y(a.to);
      const col = a.kind === 'undo' ? 'var(--del)' : 'var(--add)';
      parts.push(`<path d="M${X0} ${y1} Q${xl} ${y1} ${xl} ${y1 + 12} L${xl} ${y2 - 12} Q${xl} ${y2} ${X0} ${y2}" fill="none" style="stroke:${col}" stroke-width="1.5" stroke-dasharray="3 3" opacity=".7"/>`);
    }
    rows.forEach((e, i) => parts.push(nodeSvg(e, X0, y(i), colors)));
    return { width, html: `<svg class="graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>` };
  }

  function miniBar(a, d) {
    const total = a + d;
    if (!total) return '';
    const cells = 5;
    const na = Math.round((a / total) * cells);
    const nd = Math.min(cells - na, Math.max(d ? 1 : 0, Math.round((d / total) * cells)));
    let h = '';
    for (let i = 0; i < cells; i++) h += `<i class="${i < na ? 'a' : i < na + nd ? 'd' : ''}"></i>`;
    return `<span class="miniBar">${h}</span>`;
  }

  function rowHtml(e, colors, pad) {
    const c = colors.get(e.sessionId) || 'var(--accent)';
    const isUndo = S.targets && S.targets.undo === e.id;
    const isRedo = S.targets && S.targets.redo === e.id;
    const chips = [];
    if (e.kind === 'request') {
      if (e.status === 'open') chips.push('<span class="chip run">trabalhando</span>');
      if (e.status === 'undone') chips.push('<span class="chip undone">desfeita</span>');
      if (e.status === 'discarded') chips.push('<span class="chip">descartada</span>');
      if (e.amended) chips.push(`<span class="chip amended" title="Recebeu mensagens no meio do caminho">${I.pencil}${e.prompts.length - 1}</span>`);
    }
    if (e.forced) chips.push('<span class="chip forced">forçado</span>');
    const seq = e.kind === 'request' ? `<span class="seq" style="--c:${c}">#${e.seq}</span>`
      : e.kind === 'undo' ? `<span class="seq" style="--c:var(--del)">${I.undo}</span>`
      : e.kind === 'redo' ? `<span class="seq" style="--c:var(--add)">${I.redo}</span>` : '';
    const meta = [];
    if (e.commit) meta.push(`<code>${short(e.commit)}</code>`);
    meta.push(`<span>${ago(e.startedAt || e.at)}</span>`);
    if (e.kind === 'init') {
      if (e.fileCount != null) meta.push(`<span>${e.fileCount} arquivos no projeto</span>`);
    } else if (e.fileCount) {
      meta.push(`<span>${e.fileCount} arquivo${e.fileCount > 1 ? 's' : ''}</span>`);
      meta.push(`<span><span class="add">+${num(e.add)}</span> <span class="del">−${num(e.del)}</span></span>${miniBar(e.add, e.del)}`);
    } else if (e.kind === 'request' && e.status !== 'open') meta.push('<span>sem alterações</span>');
    const action = isUndo && !S.running ? `<button class="row-action undo" data-act="undo" title="Desfazer esta requisição">${I.undo}Desfazer</button>`
      : isRedo && !S.running ? `<button class="row-action redo" data-act="redo" title="Refazer esta requisição">${I.redo}Refazer</button>` : '';
    const cls = ['row', `kind-${e.kind}`, `st-${e.status || 'x'}`, e.kind === 'request' && !e.commit ? 'empty' : '', ui.selected === e.id ? 'sel' : ''].join(' ');
    return `<div class="${cls}" data-row="${e.id}" style="padding-left:${pad}px">
      <div class="row-main">
        <div class="row-top">${seq}<span class="title">${esc(titleOf(e))}</span>${chips.join('')}</div>
        <div class="row-meta">${meta.join('')}</div>
      </div>${action}</div>`;
  }

  function renderList() {
    const list = document.getElementById('list');
    if (!list) return;
    const rows = visibleEntries();
    rowsCache = rows;
    if (!rows.find(e => e.id === ui.selected)) {
      const first = rows.find(e => e.kind === 'request') || rows[0];
      ui.selected = first ? first.id : null;
    }
    const colors = sessionColors();
    if (!rows.length) {
      list.innerHTML = `<div class="empty-state" style="height:auto;padding:40px 20px">Nada encontrado${ui.query ? ` para “${esc(ui.query)}”` : ''}.</div>`;
      return;
    }
    const g = graph(rows, colors);
    list.style.height = rows.length * ROW_H + 'px';
    list.innerHTML = g.html + `<div class="rows">${rows.map(e => rowHtml(e, colors, g.width)).join('')}</div>`;
  }

  // -------------------------------------------------------------------------
  // detalhes

  function filesHtml(e) {
    const files = e.files || [];
    if (!files.length) return `<div class="card" style="color:var(--muted)">Nenhum arquivo alterado.</div>`;
    const rows = files.map(f => {
      const i = f.p.lastIndexOf('/');
      const dir = i >= 0 ? f.p.slice(0, i) : '';
      const name = i >= 0 ? f.p.slice(i + 1) : f.p;
      const stat = f.bin ? '<span style="color:var(--muted)">binário</span>'
        : `<span class="add">+${f.a}</span><span class="del">−${f.d}</span>${miniBar(f.a, f.d)}`;
      const via = f.via === 'other' ? '<span class="via" title="Alterado fora das ferramentas de edição (ex.: comando no terminal)">terminal</span>' : '';
      return `<div class="file s-${f.s}" data-act="diff" data-path="${esc(f.p)}" title="Ver diff de ${esc(f.p)}">
        <span class="badge s-${f.s}">${f.s}</span>
        <span class="fpath"><span class="fname">${esc(name)}</span><span class="fdir">${esc(dir)}</span></span>
        ${via}<span class="fstat">${stat}</span>
        <span class="facts">
          <button class="icon-btn" data-act="diff" data-path="${esc(f.p)}" title="Comparar antes ↔ depois">${I.diff}</button>
          ${f.s !== 'D' ? `<button class="icon-btn" data-act="openFile" data-path="${esc(f.p)}" title="Abrir arquivo">${I.open}</button>` : ''}
        </span>
      </div>`;
    }).join('');
    const more = e.filesTruncated ? `<div class="trunc">Mostrando ${files.length} de ${e.fileCount} arquivos. Use “Ver patch” para a lista completa.</div>` : '';
    return `<div class="files">${rows}${more}</div>`;
  }

  function section(title, count, body) {
    return `<div class="section"><h3>${title}${count ? `<span class="count">${count}</span>` : ''}<span class="line"></span></h3>${body}</div>`;
  }

  function clampable(key, html, long) {
    const open = ui.expanded[key];
    return `<div class="${long && !open ? 'clamped' : ''}"><div class="p-text">${html}</div></div>${long ? `<button class="more" data-act="more" data-key="${key}">${open ? 'mostrar menos' : 'mostrar mais'}</button>` : ''}`;
  }

  function planHtml(e) {
    const p = e.plan;
    const parts = [];
    if (p && p.items && p.items.length) {
      const done = p.items.filter(i => i.status === 'completed').length;
      const src = p.fromText ? 'do texto da resposta' : 'da lista de tarefas do Claude';
      const rev = e.planRevisions > 1 && !p.fromText ? ` · atualizado ${e.planRevisions}×` : '';
      parts.push(`<ul class="plan">${p.items.map(i => `<li class="${i.status}"><span class="ck">${i.status === 'completed' ? I.check : ''}</span><span class="txt">${inline(i.text)}</span></li>`).join('')}</ul>
        <div class="plan-src" style="margin-top:6px">${done}/${p.items.length} concluídos · ${src}${rev}</div>`);
    }
    if (p && p.text) {
      parts.push(`<div class="card md" style="margin-top:${parts.length ? 10 : 0}px">${clampable('plan' + e.id, md(p.text), p.text.length > 900)}</div><div class="plan-src" style="margin-top:6px">plano aprovado no plan mode</div>`);
    }
    if (parts.length) return section('Plano', '', parts.join(''));
    if (e.intro) {
      return section('Abordagem', '', `<div class="card md">${clampable('intro' + e.id, md(e.intro), e.intro.length > 600)}</div>
        <div class="plan-src" style="margin-top:6px">primeira resposta do Claude (nenhum plano estruturado registrado)</div>`);
    }
    if (e.status === 'open') return section('Plano', '', '<div class="card" style="color:var(--muted)">Aguardando o Claude…</div>');
    return '';
  }

  function hintFor(e) {
    if (e.kind !== 'request') return '';
    if (e.status === 'open') return 'O Claude ainda está trabalhando nesta requisição.';
    if (S.targets.undo === e.id || S.targets.redo === e.id) return '';
    if (S.running) return 'Desfazer e refazer ficam disponíveis quando o Claude terminar.';
    if (e.status === 'discarded') return 'Descartada: outra requisição alterou arquivos depois que esta foi desfeita.';
    if (e.status === 'undone') { const r = entryById(S.targets.redo); return r ? `Desfeita. Refaça antes a #${r.seq}.` : 'Desfeita.'; }
    if (e.commit) { const u = entryById(S.targets.undo); return u ? `Só a requisição aplicada mais recente pode ser desfeita (agora: #${u.seq}).` : ''; }
    return '';
  }

  function renderDetail() {
    const box = document.getElementById('detail');
    if (!box) return;
    const e = entryById(ui.selected);
    if (!e) { box.innerHTML = '<div class="empty-state">Selecione uma linha.</div>'; return; }
    const colors = sessionColors();
    const c = colors.get(e.sessionId) || 'var(--accent)';
    const h = [];
    const badge = e.kind === 'request' ? `#${e.seq}` : e.kind === 'undo' ? I.undo : e.kind === 'redo' ? I.redo : e.kind === 'manual' ? '✎' : '◆';
    const badgeColor = e.kind === 'undo' ? 'var(--del)' : e.kind === 'redo' ? 'var(--add)' : e.kind === 'request' ? c : 'var(--muted)';
    const sub = [];
    if (e.kind === 'request') {
      if (e.status === 'open') sub.push('<span class="chip run">trabalhando</span>');
      if (e.status === 'undone') sub.push('<span class="chip undone">desfeita</span>');
      if (e.status === 'discarded') sub.push('<span class="chip">descartada</span>');
      if (e.interrupted) sub.push('<span class="chip" title="O Claude foi interrompido ou a sessão terminou antes do fim">interrompida</span>');
      if (e.amended) sub.push('<span class="chip amended">alterada no meio do caminho</span>');
      sub.push(`<span class="chip sess" style="--c:${c}" title="Sessão ${esc(e.sessionId)}">sessão ${esc(String(e.sessionId).slice(0, 8))}</span>`);
      sub.push(`<span>${when(e.startedAt)}${e.endedAt ? ' · ' + dur(e.startedAt, e.endedAt) : ''}</span>`);
    } else {
      sub.push(`<span>${when(e.at)}</span>`);
      if (e.forced) sub.push('<span class="chip forced">forçado</span>');
    }
    if (e.commit) sub.push(`<span class="sha" data-act="copy" data-text="${esc(e.commit)}" title="Copiar hash">${I.copy}<code>${short(e.commit)}</code></span>`);
    h.push(`<div class="det-head"><div class="det-badge" style="--c:${badgeColor}">${badge}</div><div style="min-width:0">
      <h2>${esc(titleOf(e))}</h2><div class="det-sub">${sub.join('')}</div></div></div>`);

    const acts = [];
    if (S.targets.undo === e.id) acts.push(`<button class="btn danger" data-act="undo" ${S.running ? 'disabled' : ''}>${I.undo}Desfazer requisição #${e.seq}</button>`);
    if (S.targets.redo === e.id) acts.push(`<button class="btn good" data-act="redo" ${S.running ? 'disabled' : ''}>${I.redo}Refazer requisição #${e.seq}</button>`);
    if ((e.kind === 'undo' || e.kind === 'redo') && entryById(e.target)) acts.push(`<button class="btn" data-act="goto" data-id="${e.target}">${I.arrow}Ir para #${e.seq}</button>`);
    if (e.commit && e.parent) acts.push(`<button class="btn" data-act="patch">${I.patch}Ver patch (git diff)</button>`);
    if (acts.length) h.push(`<div class="det-actions">${acts.join('')}</div>`);
    const hint = hintFor(e);
    if (hint) h.push(`<p class="hint">${esc(hint)}</p>`);

    if (e.kind === 'request') {
      if (e.prompts && e.prompts.length) {
        const ps = e.prompts.map((p, i) => {
          const label = i === 0 ? `Pedido · ${when(p.at)}` : `${I.pencil} Alteração no meio do caminho · ${when(p.at)}`;
          return `<div class="prompt ${i ? 'amend' : ''}"><div class="p-label">${label}</div>${clampable('p' + e.id + i, esc(p.text), p.text.length > 700 || p.text.split('\n').length > 9)}</div>`;
        }).join('');
        h.push(section('Pedido', e.prompts.length > 1 ? `${e.prompts.length} mensagens` : '', ps));
      } else {
        h.push(section('Pedido', '', '<div class="card" style="color:var(--muted)">Sem mensagem do usuário: o Claude continuou sozinho (ex.: aviso de tarefa em segundo plano).</div>'));
      }
      h.push(planHtml(e));
    } else if (e.kind === 'manual') {
      h.push('<p class="hint">Edições feitas fora do Claude (por você ou outra ferramenta) entre requisições. Ficam separadas para não serem atribuídas a nenhuma requisição.</p>');
    } else if (e.kind === 'init') {
      h.push(`<p class="hint">Fotografia do projeto quando o histórico começou${e.fileCount != null ? ` (${e.fileCount} arquivos)` : ''}.</p>`);
    } else if (e.forced && e.conflicts && e.conflicts.length) {
      h.push(`<p class="hint">Sobrescreveu edições posteriores em: ${e.conflicts.map(esc).join(', ')} (salvas na linha “Alterações fora do Claude” logo abaixo).</p>`);
    }

    if (e.kind !== 'init') {
      const stat = e.fileCount ? `${e.fileCount} · <span class="add">+${num(e.add)}</span> <span class="del">−${num(e.del)}</span>` : '';
      h.push(section('Arquivos alterados', stat, e.status === 'open' ? '<div class="card" style="color:var(--muted)">Os arquivos aparecem quando o Claude terminar a requisição.</div>' : filesHtml(e)));
    }
    if (e.summary) {
      h.push(section('Resposta final do Claude', '', `<div class="card md">${clampable('s' + e.id, md(e.summary), e.summary.length > 700)}</div>`));
    }
    h.push(`<div class="legend">
      <span><svg width="14" height="14"><circle cx="7" cy="7" r="5" fill="${PALETTE[0]}"/></svg>requisição (cor = sessão)</span>
      <span><svg width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-dasharray="2 2" stroke-width="1.5" style="color:var(--del)"/></svg>desfeita</span>
      <span><svg width="14" height="14"><rect x="3.5" y="3.5" width="7" height="7" transform="rotate(45 7 7)" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>edição manual</span>
      <span><svg width="22" height="14"><path d="M1 7h20" stroke="currentColor" stroke-dasharray="3 3" style="color:var(--del)"/></svg>desfazer/refazer → requisição</span>
    </div>`);
    const top = box.scrollTop;
    const same = box.dataset.id === e.id;
    box.innerHTML = h.join('');
    box.dataset.id = e.id;
    if (same) box.scrollTop = top;
  }

  // -------------------------------------------------------------------------
  // eventos

  function select(id, scroll) {
    ui.selected = id;
    persist();
    document.querySelectorAll('.row.sel').forEach(r => r.classList.remove('sel'));
    const row = document.querySelector(`.row[data-row="${CSS.escape(id)}"]`);
    if (row) {
      row.classList.add('sel');
      if (scroll) row.scrollIntoView({ block: 'nearest' });
    }
    renderDetail();
  }

  app.addEventListener('click', ev => {
    const act = ev.target.closest('[data-act]');
    if (act) {
      ev.stopPropagation();
      const a = act.dataset.act;
      const e = entryById(ui.selected);
      switch (a) {
        case 'undo': case 'redo': vscode.postMessage({ type: a }); break;
        case 'patch': vscode.postMessage({ type: 'patch', id: e.id }); break;
        case 'diff': vscode.postMessage({ type: 'diff', id: e.id, path: act.dataset.path }); break;
        case 'openFile': vscode.postMessage({ type: 'openFile', path: act.dataset.path }); break;
        case 'copy': vscode.postMessage({ type: 'copy', text: act.dataset.text }); break;
        case 'popout': vscode.postMessage({ type: 'popout' }); break;
        case 'goto': ui.query = ''; document.getElementById('q').value = ''; renderList(); select(act.dataset.id, true); break;
        case 'more': ui.expanded[act.dataset.key] = !ui.expanded[act.dataset.key]; renderDetail(); break;
        case 'toggleManual': ui.showManual = !ui.showManual; persist(); render(); break;
        case 'toggleEmpty': ui.showEmpty = !ui.showEmpty; persist(); render(); break;
        default:
      }
      return;
    }
    const row = ev.target.closest('[data-row]');
    if (row) select(row.dataset.row);
  });

  document.addEventListener('keydown', ev => {
    if (ev.target && ev.target.id === 'q') return;
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const i = rowsCache.findIndex(e => e.id === ui.selected);
    const next = rowsCache[Math.min(rowsCache.length - 1, Math.max(0, i + (ev.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { ev.preventDefault(); select(next.id, true); }
  });

  window.addEventListener('message', ev => {
    const m = ev.data || {};
    if (m.type === 'state') {
      const listWrap = document.getElementById('listWrap');
      const top = listWrap ? listWrap.scrollTop : 0;
      S = m.state;
      render();
      const lw = document.getElementById('listWrap');
      if (lw) lw.scrollTop = top;
    } else if (m.type === 'select') {
      ui.query = '';
      const q = document.getElementById('q');
      if (q) q.value = '';
      renderList();
      select(m.id, true);
    } else if (m.type === 'busy') {
      const b = document.getElementById('busy');
      if (b) b.classList.toggle('on', !!m.on);
    }
  });

  // atualiza os "há N min"
  setInterval(() => { if (S && S.entries) { renderList(); } }, 60000);

  shell();
  renderTop();
  vscode.postMessage({ type: 'ready' });
})();

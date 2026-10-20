/* ===== scope-addon.js — Quizz Ôn Tập =====
 * 1) Tách tài liệu theo mục (NGÀY / Chương / Bài ...) và chọn phạm vi tạo câu hỏi
 * 2) Game Quiz: chọn số câu tùy ý (tới 200), tạo theo từng đợt
 * 3) Chống câu hỏi trùng mạnh hơn (cùng đáp án, cùng đề, hỏi ngược)
 * Dán khối này SAU script chính, ngay trước thẻ đóng body.
 */
(function () {
  'use strict';
  if (window.__scopeAddon) return;
  window.__scopeAddon = true;

  const DEF_PAT = 'NGÀY|Chương|Bài|Phần|Unit|Day|Chapter|Lesson';
  const MAX_GAME = 200;
  S.scopes = S.scopes || {};

  /* ---------- CSS ---------- */
  document.head.insertAdjacentHTML('beforeend', `<style>
  .sc{margin:14px 0}.sc .sc-h{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
  .sc-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}
  .sc-row input[type=text]{flex:1;min-width:150px;width:auto}
  .sc-list{max-height:230px;overflow:auto;display:grid;gap:6px;margin-top:8px}
  .sc-it{display:flex;gap:8px;align-items:center;font-weight:500;margin:0;padding:7px 10px;border:1px solid var(--ln);border-radius:9px;background:var(--card);cursor:pointer;font-size:14px}
  .sc-it:hover{border-color:var(--pri)}.sc-it.on{border-color:var(--pri);background:var(--tint)}
  .sc-it b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
  .sc-it span{color:var(--mu);font-size:12px;white-space:nowrap}
  .sc-sum{font-size:13px;color:var(--mu);margin:6px 0 0}.sc details>summary{cursor:pointer;font-weight:600;color:var(--pri)}
  </style>`);

  /* ---------- Tách mục ---------- */
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function scRegex(pat) {
    const words = String(pat || '').split(/[|,;\n]+/).map(s => s.trim()).filter(Boolean).map(escRe);
    if (!words.length) return null;
    return new RegExp('^\\s*(?:' + words.join('|') + ')\\s*(\\d+)', 'iu');
  }
  function splitSections(text, pat) {
    const re = scRegex(pat);
    if (!re) return [];
    const secs = [];
    let cur = null;
    for (const line of String(text || '').split(/\r?\n/)) {
      const m = line.length <= 160 ? line.match(re) : null;
      if (m) {
        cur = { label: line.trim().slice(0, 90), num: +m[1], body: [line] };
        secs.push(cur);
      } else if (cur) cur.body.push(line);
    }
    secs.forEach(s => { s.text = s.body.join('\n').trim(); delete s.body; });
    return secs.filter(s => s.text.length > 0);
  }

  /* ---------- Trạng thái phạm vi ---------- */
  const isSaved = id => id !== 'draft' && id !== 'tmp';
  const savedScopes = () => ld('docScopes', {});
  function getScope(id) {
    if (!S.scopes[id]) {
      const st = isSaved(id) ? savedScopes()[id] : null;
      S.scopes[id] = { pat: (st && st.pat) || ld('scopePat', DEF_PAT), sel: st && Array.isArray(st.sel) ? st.sel : null, quick: '' };
    }
    return S.scopes[id];
  }
  function scGet(id, text) {
    const sc = getScope(id);
    if (id === 'tmp') {
      const sig = text.length + ':' + text.slice(0, 50);
      if (sc.fresh) { sc.sig = sig; sc.fresh = false; }
      else if (sc.sig && sc.sig !== sig) { sc.sel = null; sc.sig = sig; }
    }
    return sc;
  }
  function persist(id) {
    const sc = getScope(id);
    sv('scopePat', sc.pat);
    if (isSaved(id)) { const all = savedScopes(); all[id] = { pat: sc.pat, sel: sc.sel }; sv('docScopes', all); }
  }
  function scText(id) {
    if (id === 'draft') { const t = $('#tx'); return t ? t.value : (S.draft && S.draft.text) || ''; }
    if (id === 'tmp') return (S.temp && S.temp.text) || '';
    const d = docs().find(x => x.id == id);
    return d ? d.text : '';
  }
  function scName(id) {
    if (id === 'draft') { const n = $('#dn'); return (n && n.value) || 'Tài liệu đang tải'; }
    if (id === 'tmp') return (S.temp && S.temp.name) || 'Tài liệu vừa tải';
    const d = docs().find(x => x.id == id);
    return d ? d.name : '';
  }
  const selIdx = (sc, n) => sc.sel === null ? [...Array(n).keys()] : sc.sel.filter(i => i >= 0 && i < n);

  /* Trả về nội dung đã lọc theo phạm vi cho một tài liệu */
  function scopedText(id, full) {
    const sc = scGet(id, full), secs = splitSections(full, sc.pat);
    if (!secs.length) return { text: full, labels: '' };
    const idx = selIdx(sc, secs.length);
    if (!idx.length) return { empty: true };
    if (idx.length === secs.length) return { text: full, labels: '' };
    return {
      text: idx.map(i => secs[i].text).join('\n\n'),
      labels: idx.map(i => secs[i].label.split(/[:\-–]/)[0].trim()).join(', ')
    };
  }

  /* ---------- Giao diện ---------- */
  function panel(id) {
    const text = scText(id);
    if (text.trim().length < 50) return `<div data-sc="${id}"></div>`;
    const sc = scGet(id, text), secs = splitSections(text, sc.pat), idx = new Set(selIdx(sc, secs.length));
    const patRow = `<div class="sc-row"><label style="margin:0">Mẫu nhận diện tiêu đề</label>
      <input type="text" value="${esc(sc.pat)}" placeholder="NGÀY|Chương|Bài" aria-label="Mẫu nhận diện tiêu đề" onchange="scPat('${id}',this.value)">
      <button type="button" class="btn sm o" onclick="scPat('${id}','${DEF_PAT}')">Mặc định</button></div>
      <p class="mu" style="margin:0;font-size:12px">Nhập các từ mở đầu tiêu đề, cách nhau bằng dấu |. Tiêu đề phải có số (VD: “Ngày 2”, “Chương 3”).</p>`;
    if (!secs.length) {
      return `<div class="exp sc" data-sc="${id}"><details><summary>Chọn phạm vi theo mục (không tìm thấy mục nào — sẽ dùng toàn bộ tài liệu)</summary>${patRow}</details></div>`;
    }
    const chars = [...idx].reduce((a, i) => a + secs[i].text.length, 0);
    return `<div class="exp sc" data-sc="${id}">
      <div class="sc-h"><b>Phạm vi tạo câu hỏi</b><span class="mu">${esc(scName(id))}</span></div>
      <div class="sc-row">
        <button type="button" class="btn sm o" onclick="scAll('${id}',true)">Chọn tất cả</button>
        <button type="button" class="btn sm o" onclick="scAll('${id}',false)">Bỏ chọn</button>
        <input type="text" value="${esc(sc.quick || '')}" placeholder="Nhập nhanh: 2-4 hoặc 2, 5" aria-label="Nhập nhanh các mục" onchange="scQuick('${id}',this.value)" onkeydown="if(event.key==='Enter'){scQuick('${id}',this.value)}">
        <button type="button" class="btn sm" onclick="scQuick('${id}',this.previousElementSibling.value)">Áp dụng</button>
      </div>
      <div class="sc-list">${secs.map((s, i) => `<label class="sc-it ${idx.has(i) ? 'on' : ''}"><input type="checkbox" ${idx.has(i) ? 'checked' : ''} onchange="scToggle('${id}',${i})"><b>${esc(s.label)}</b><span>${s.text.length.toLocaleString('vi-VN')} ký tự</span></label>`).join('')}</div>
      <p class="sc-sum">Đã chọn <b>${idx.size}/${secs.length}</b> mục · ${chars.toLocaleString('vi-VN')} ký tự sẽ được gửi cho AI${idx.size === 0 ? ' — <span class="bad">hãy chọn ít nhất 1 mục</span>' : ''}</p>
      <details style="margin-top:8px"><summary>Đổi mẫu nhận diện</summary>${patRow}</details></div>`;
  }
  function refresh(id) {
    document.querySelectorAll('[data-sc="' + id + '"]').forEach(el => { el.outerHTML = panel(id); });
  }
  function parseQuick(v, secs) {
    const t = String(v || '').trim();
    if (!t || /^(all|tat ca|tất cả)$/i.test(t)) return null;
    const nums = new Set();
    t.split(/[,;\s]+/).filter(Boolean).forEach(p => {
      const m = p.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (m) { let a = +m[1], b = +m[2]; if (a > b) [a, b] = [b, a]; for (let x = a; x <= Math.min(b, a + 999); x++) nums.add(x); }
      else if (/^\d+$/.test(p)) nums.add(+p);
    });
    if (!nums.size) return false;
    const res = [];
    secs.forEach((s, i) => { if (nums.has(Number.isFinite(s.num) ? s.num : i + 1)) res.push(i); });
    return res;
  }
  window.scToggle = function (id, i) {
    const text = scText(id), sc = scGet(id, text), secs = splitSections(text, sc.pat), cur = new Set(selIdx(sc, secs.length));
    cur.has(i) ? cur.delete(i) : cur.add(i);
    sc.sel = cur.size === secs.length ? null : [...cur].sort((a, b) => a - b);
    sc.quick = ''; persist(id); refresh(id);
  };
  window.scAll = function (id, on) { const sc = getScope(id); sc.sel = on ? null : []; sc.quick = ''; persist(id); refresh(id); };
  window.scPat = function (id, v) { const sc = getScope(id); sc.pat = String(v || '').trim() || DEF_PAT; sc.sel = null; sc.quick = ''; persist(id); refresh(id); };
  window.scQuick = function (id, v) {
    const text = scText(id), sc = scGet(id, text), secs = splitSections(text, sc.pat), r = parseQuick(v, secs);
    if (r === false) { toast('Không hiểu “' + v + '”. Hãy nhập dạng 2-4 hoặc 2, 5.', 'e'); return; }
    if (Array.isArray(r) && !r.length) { toast('Không có mục nào khớp với “' + v + '”.', 'e'); return; }
    sc.sel = r === null || r.length === secs.length ? null : r; sc.quick = String(v || '').trim();
    persist(id); refresh(id);
  };
  const cloneScope = s => ({ pat: s.pat, sel: s.sel === null ? null : [...s.sel], quick: '', fresh: true });

  /* ---------- Gắn giao diện vào các trang ---------- */
  const vDocs = V.docs;
  V.docs = function () {
    vDocs();
    const tg = $('#tg'), grid = tg && tg.closest('.grid');
    if (!grid) return;
    grid.insertAdjacentHTML('afterend', panel('draft'));
    const tx = $('#tx');
    if (tx) tx.addEventListener('input', () => { clearTimeout(S._scT); S._scT = setTimeout(() => refresh('draft'), 500); });
  };
  const vDoc = V.doc;
  V.doc = function () {
    vDoc();
    const c = $('#app .card');
    if (c && S.did) c.insertAdjacentHTML('afterend', panel(S.did));
  };
  const vMk = V.mk;
  V.mk = function () {
    vMk();
    try {
      const pn = $('#pn'), m = S.mode;
      if (!pn || !['ai', 'game', 'exam'].includes(m)) return;
      if (m === 'game' && !pn.querySelector('.qv-doc')) return;
      if (m === 'exam' && ((S.examSource || 'doc') === 'bank' || (S.examFiles && S.examFiles.length))) return;
      const ids = (S.sel || []).filter(id => (id === 'tmp' && S.temp) || docs().some(x => x.id === id));
      if (!ids.length) return;
      const html = ids.map(panel).join('');
      let anchor;
      if (m === 'game') { anchor = pn.querySelector('.qv-source'); anchor && anchor.insertAdjacentHTML('afterend', html); }
      else if (m === 'ai') { anchor = pn.querySelectorAll('.exp')[1]; anchor ? anchor.insertAdjacentHTML('beforebegin', html) : ($('#go') && $('#go').insertAdjacentHTML('beforebegin', html)); }
      else { anchor = $('#go'); anchor && anchor.insertAdjacentHTML('beforebegin', html); }
    } catch (e) { console.warn('scope mount', e); }
  };

  /* ---------- Đồng bộ phạm vi khi lưu / dùng tài liệu ---------- */
  const _upl = upl;
  upl = async function (fs) { await _upl(fs); refresh('draft'); };

  const _useDraftNow = useDraftNow;
  useDraftNow = async function (mode) { S.scopes.tmp = cloneScope(getScope('draft')); return _useDraftNow(mode); };

  const _useTemp = useTemp;
  useTemp = function () { S.scopes.tmp = cloneScope(getScope('draft')); const r = _useTemp(); delete S.scopes.draft; return r; };

  const _saveDoc = saveDoc;
  saveDoc = function (then) {
    const before = docs().map(x => x.id), did = S.draft && S.draft.id, sc = cloneScope(getScope('draft'));
    const r = _saveDoc(then);
    const nd = did || (docs().find(x => !before.includes(x.id)) || {}).id;
    if (nd && docs().some(x => x.id === nd)) { S.scopes[nd] = { ...sc, fresh: false }; persist(nd); delete S.scopes.draft; }
    return r;
  };

  const _saveTemp = saveTemp;
  saveTemp = function (e) {
    const before = docs().map(x => x.id), sc = cloneScope(getScope('tmp'));
    const r = _saveTemp(e);
    const nd = (docs().find(x => !before.includes(x.id)) || {}).id;
    if (nd) { S.scopes[nd] = { ...sc, fresh: false }; persist(nd); }
    return r;
  };

  const _openDoc = openDoc;
  openDoc = function (id) { S.scopes.draft = { ...cloneScope(getScope(id)), fresh: false }; return _openDoc(id); };

  /* ---------- Game Quiz: chọn số câu tùy ý ---------- */
  const pGame = P.game;
  P.game = function () {
    const h = pGame(), n = Math.min(MAX_GAME, Math.max(1, parseInt(S.f.n) || 10));
    const btns = [5, 10, 20, 30, 50, 100].map(v => `<button class="${n === v ? 'on' : ''}" onclick="S.f.n=${v};V.mk()">${v}</button>`).join('');
    const ctl = `<label>Số câu</label><div class="qv-seg" style="flex-wrap:wrap">${btns}</div>
      <div class="row" style="margin-top:8px"><input type="number" min="1" max="${MAX_GAME}" value="${n}" style="width:100px" aria-label="Số câu tùy chọn" onchange="S.f.n=Math.min(${MAX_GAME},Math.max(1,parseInt(this.value)||10));V.mk()"><span class="mu">câu · tối đa ${MAX_GAME}</span></div>
      ${n > 30 ? '<p class="mu" style="margin:6px 0 0;font-size:12px">Số câu lớn được tạo theo từng đợt nên sẽ mất vài phút.</p>' : ''}`;
    return h.replace(/<label>Số câu<\/label><div class="qv-seg">[\s\S]*?<\/div>/, () => ctl);
  };

  /* ---------- Chống trùng câu hỏi ---------- */
  let DUPMODE = 'source';
  const GENERIC = new Set(['co', 'khong', 'dung', 'sai', 'tat ca', 'khac']);
  const wordsOf = s => aiNorm(s).split(' ').filter(w => w.length > 2);
  function sameQ(a, b) {
    const na = aiNorm(a.q), nb = aiNorm(b.q);
    if (!na || !nb) return false;
    if (na === nb) return true;
    const wa = new Set(wordsOf(a.q)), wb = new Set(wordsOf(b.q));
    let c = 0; wa.forEach(w => { if (wb.has(w)) c++; });
    const un = wa.size + wb.size - c, jac = un ? c / un : 0;
    const dn = (na.match(/\d+/g) || []).join() !== (nb.match(/\d+/g) || []).join();
    if (jac >= 0.75 && (!dn || jac >= 0.95)) return true;
    const ca = aiNorm(a.o[a.c]), cb = aiNorm(b.o[b.c]);
    const okAns = x => x.length >= 2 && !/^[0-9 ]*$/.test(x) && !GENERIC.has(x);
    if (ca && ca === cb && okAns(ca) && (DUPMODE === 'source' || jac >= 0.3)) return true;
    if (a.o.map(aiNorm).sort().join('|') === b.o.map(aiNorm).sort().join('|')) return true;
    if (okAns(ca) && okAns(cb) && (' ' + nb + ' ').includes(' ' + ca + ' ') && (' ' + na + ' ').includes(' ' + cb + ' ')) return true;
    return false;
  }
  function dedupeStrong(list) {
    const out = [];
    for (const x of list) if (!out.some(y => sameQ(x, y))) out.push(x);
    return out;
  }

  async function callAI2(text, n, lv, sj, excluded, qmode, batch) {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 70000);
    let res, data;
    try {
      res = await fetch('/.netlify/functions/generate-quiz', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({ text, count: n, level: lv, subject: sj, exclude: excluded.filter(x => typeof x === 'string').slice(-80), quizMode: qmode, batch })
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      throw Error(e.name === 'AbortError' ? 'Máy chủ phản hồi quá lâu. Hãy thử lại.' : 'Không thể kết nối máy chủ. Kiểm tra mạng hoặc Netlify Functions.');
    } finally { clearTimeout(tm); }
    if (res.status === 404) throw Error('Không tìm thấy generate-quiz trên Netlify. Kiểm tra đường dẫn Functions và deploy lại.');
    if (!res.ok) throw Error(data.error || ((res.status === 429 || res.status === 503) ? 'Hệ thống AI đang quá tải. Hãy thử lại sau.' : 'Máy chủ chưa tạo được câu hỏi.'));
    return { list: clean(data.questions), note: typeof data.note === 'string' ? data.note : '' };
  }

  /* Tạo theo từng đợt (≤20 câu/lần) cho tới khi đủ số câu hoặc hết nội dung mới */
  async function gen2(text, n, lv, sj, qmode, prog) {
    const source = text.slice(0, 24000);
    let hash = 2166136261;
    for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
    const key = 'aiSeenV3_' + (hash >>> 0) + '_' + qmode;
    const previous = ld(key, []).filter(x => typeof x === 'string').slice(-150);
    DUPMODE = qmode === 'apply' ? 'apply' : 'source';
    const out = [], maxCalls = Math.ceil(n / 12) + 8;
    let note = '', lastErr = null, calls = 0, fails = 0, stale = 0;
    while (out.length < n && calls < maxCalls && fails < 3 && stale < 3) {
      const ask = Math.min(n - out.length, 20);
      const excl = [...out.map(x => x.q), ...(calls < 2 ? previous.slice(-30) : [])];
      let r;
      try { r = await callAI2(source, ask, lv, sj, excl, qmode, calls++); }
      catch (e) { lastErr = e; fails++; await new Promise(ok => setTimeout(ok, 1500)); continue; }
      note = r.note || note;
      let added = 0;
      for (const x of r.list) {
        if (out.length >= n) break;
        if (!out.some(y => sameQ(x, y))) { out.push(x); added++; }
      }
      stale = added ? 0 : stale + 1;
      if (prog) prog(out.length, n);
    }
    if (!out.length) throw lastErr || Error(note || 'Không thể tạo câu hỏi. Kiểm tra tài liệu hoặc cấu hình AI.');
    sv(key, [...previous, ...out.map(x => x.q)].slice(-150));
    return out;
  }

  /* ---------- build(): chỉ gửi phần đã chọn, hỗ trợ số câu lớn ---------- */
  build = async function () {
    const all = [...(S.temp ? [S.temp] : []), ...docs()], ids = S.sel.length ? S.sel : [ld('lastDoc', '')], ds = all.filter(x => ids.includes(x.id));
    S.notice = ''; S.err = ''; S.retry = 0;
    if (!ds.length) { S.err = 'Hãy chọn ít nhất một tài liệu.'; V.mk(); return; }
    if (S.building) return;
    const mode = S.mode, exam = mode === 'exam', game = mode === 'game';
    const parts = [], labels = [];
    for (const d of ds) {
      const r = scopedText(d.id, d.text);
      if (r.empty) { S.err = 'Bạn chưa chọn mục nào trong “' + d.name + '”. Hãy chọn ít nhất một mục.'; V.mk(); return; }
      parts.push('## ' + d.name + (r.labels ? ' (' + r.labels + ')' : '') + '\n' + r.text);
      if (r.labels) labels.push(r.labels);
    }
    const scopeLabel = [...new Set(labels.join(', ').split(', ').filter(Boolean))].join(', ');
    const n = clamp(S.f.n, 1, game ? MAX_GAME : 50), b = $('#go');
    S.building = true;
    if (b) { b.disabled = true; b.innerHTML = '<span class="sp"></span>Đang phân tích tài liệu...'; }
    const box = $('#ld');
    const say = t => { if (box) box.innerHTML = '<div class="prog an"><i></i></div><p class="mu">' + t + '</p>'; };
    say('Việc này có thể mất từ 10 đến 60 giây' + (n > 20 ? ' (số câu lớn sẽ tạo theo từng đợt)' : '') + '.');
    try {
      const subj = [...new Set(ds.map(d => d.subject).filter(Boolean))].join(', ') + (S.f.topic ? ' – ' + S.f.topic : '') + (scopeLabel ? ' – ' + scopeLabel : '');
      const pool = dedupeStrong(await gen2(parts.join('\n\n'), n, S.f.lv, subj, S.f.qmode || 'source', (k, t) => say('Đã tạo ' + k + '/' + t + ' câu...')));
      if (pool.length < n) S.notice = 'Tài liệu/phạm vi đã chọn hiện chỉ đủ dữ liệu để tạo ' + pool.length + ' câu không trùng (bạn yêu cầu ' + n + ' câu). Hãy mở rộng phạm vi nếu cần thêm.';
      pool.forEach(x => { if (!x.t && S.f.topic) x.t = S.f.topic; });
      const title = (S.f.title || '').trim() || ('Đề từ: ' + ds.map(d => d.name).join(', ').slice(0, 80) + (scopeLabel ? ' · ' + scopeLabel.slice(0, 40) : ''));
      S.quiz = mkq(pool, pool.length, 1, title, ds[0].subject || 'Chưa có môn', game ? 0 : (exam ? clamp(S.f.extl, 5, 60) : S.f.tl) * 60, exam);
      if (ds[0].id != 'tmp') sv('lastDoc', ds[0].id);
      S.quiz.ai = 1; S.quiz.game = game; S.quiz.gsec = clamp(S.f.gtime, 10, 90);
      S.quiz.src = ds.map(d => d.name).join(', ') + (scopeLabel ? ' (' + scopeLabel + ')' : '');
      S.quiz.chapter = S.f.topic || scopeLabel;
      S.quiz.docs = ds.map(d => d.id).filter(i => i != 'tmp');
      S.v = 'ready'; V.ready();
    } catch (e) { S.err = e.message || 'Không tạo được câu hỏi.'; S.retry = 1; V.mk(); }
    finally { S.building = false; }
  };

  window.__scopeTest = { splitSections, parseQuick, sameQ, scRegex };
  if (S.v === 'mk') V.mk(); else if (S.v === 'docs') V.docs();
})();

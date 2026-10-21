/* ===== scope-addon.js (v2) — Quizz Ôn Tập =====
 * 1) Nhận diện cấu trúc tài liệu tự động + chọn phạm vi thủ công (state tách bạch, không tự khôi phục)
 * 2) Ô yêu cầu bằng ngôn ngữ tự nhiên -> AI xác định phạm vi, trích xuất nguyên văn, xem trước, gửi đúng phần đó
 * 3) Xóa từng file / xóa tất cả file đã tải lên
 * 4) Game Quiz: chọn số câu tùy ý (tới 200), tạo theo từng đợt
 * 5) Chống câu hỏi trùng mạnh hơn
 * Dán SAU script chính, ngay trước thẻ đóng body.
 */
(function () {
  'use strict';
  if (window.__scopeAddon2) return;
  window.__scopeAddon2 = true;

  const MAX_GAME = 200;
  const EXAMPLES = [
    'Chỉ lấy nội dung Ngày 1',
    'Lấy Ngày 1 và Ngày 3, bỏ qua Ngày 2',
    'Lấy 30 từ vựng đầu tiên, không lấy ví dụ',
    'Lấy từ tiêu đề Announcements đến trước Business Meetings'
  ];
  S.scopes = S.scopes || {};

  /* ---------- CSS ---------- */
  document.head.insertAdjacentHTML('beforeend', `<style>
  .sc{margin:14px 0}.sc .sc-h{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
  .sc-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}
  .sc-row input[type=text]{flex:1;min-width:150px;width:auto}
  .sc .sc-lb{margin:10px 0 6px;font-weight:700}
  .sc textarea.sc-req{min-height:60px;height:64px}.sc textarea.sc-prev{min-height:150px;font-size:13px}
  .sc-chips{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}
  .sc-chip{font:inherit;font-size:12.5px;border:1px solid var(--ln);background:var(--card);color:var(--pri);border-radius:20px;padding:4px 11px;cursor:pointer}
  .sc-chip:hover{border-color:var(--pri);background:var(--tint)}
  .sc-tag{display:inline-block;background:var(--card);border:1px solid var(--ln);border-radius:20px;padding:2px 10px;font-size:12.5px;margin:0 6px 4px 0}
  .sc-list{max-height:230px;overflow:auto;display:grid;gap:6px;margin-top:8px}
  .sc-it{display:flex;gap:8px;align-items:center;font-weight:500;margin:0;padding:7px 10px;border:1px solid var(--ln);border-radius:9px;background:var(--card);cursor:pointer;font-size:14px}
  .sc-it:hover{border-color:var(--pri)}.sc-it.on{border-color:var(--pri);background:var(--tint)}
  .sc-it b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
  .sc-it span{color:var(--mu);font-size:12px;white-space:nowrap}
  .sc-x{border:0;background:none;color:var(--no);cursor:pointer;font-size:15px;padding:0 4px}
  .sc-sum{font-size:13px;color:var(--mu);margin:6px 0 0}
  .sc-sep{margin:14px 0 4px;padding-top:10px;border-top:1px dashed var(--ln);font-weight:700;font-size:13.5px}
  .sc-card{margin:10px 0;padding:12px;border:1px solid var(--ln);border-radius:12px;background:var(--card)}
  .sc-card.ok{border-color:var(--ok)}
  .sc-busy{display:flex;align-items:center;gap:10px;margin:10px 0;color:var(--pri);font-weight:600}
  .sc-spin{width:16px;height:16px;border:3px solid var(--ln);border-top-color:var(--pri);border-radius:50%;animation:r 1s linear infinite;flex:none}
  .sc details>summary{cursor:pointer;font-weight:600;color:var(--pri)}
  </style>`);

  /* ===================================================================
   *  PHÂN TÍCH CẤU TRÚC (tự động, không cần mẫu nhận diện)
   * =================================================================== */
  const KW1 = 'ngày|ngay|day|buổi|buoi|session|tuần|tuan|week|chương|chuong|chapter|unit|module';
  const KW2 = 'bài|bai|lesson|mục|muc|section|phần|phan|part|topic|chủ đề|chu de';
  const KWRE = new RegExp('^\\s*(?:#{1,6}\\s*)?(?:\\*\\*|__)?\\s*(' + KW1 + '|' + KW2 + ')\\s*([0-9]{1,4}|[IVX]{1,4})(?![\\p{L}\\p{N}])', 'iu');
  const KW1RE = new RegExp('^(?:' + KW1 + ')$', 'iu');
  const NUMRE = /^\s*(\d+(?:\.\d+){1,3})\.?\s+(\p{L}.{0,100})$/u;
  const MDRE = /^\s*(#{1,6})\s+(\S.*)$/u;
  const PAGERE = /^\s*={2,}\s*Trang\s+(\d+)\s*={2,}\s*$/i;
  const PAGE_STRIP = /^\s*={2,}\s*Trang\s+\d+\s*={2,}\s*$/gim;

  function romanToInt(s) { const m = { I: 1, V: 5, X: 10 }; let t = 0; for (let i = 0; i < s.length; i++) { const v = m[s[i]], n = m[s[i + 1]] || 0; t += v < n ? -v : v; } return t; }
  function isCaps(s) {
    const t = s.trim();
    if (t.length < 4 || t.length > 80) return false;
    const letters = t.match(/\p{L}/gu) || [];
    if (letters.length < 4) return false;
    const up = letters.filter(c => c === c.toUpperCase() && c !== c.toLowerCase()).length;
    return up / letters.length >= 0.9 && !/[.!?]$/.test(t) && !/\d{3,}/.test(t);
  }
  const clean = s => s.trim().replace(/^#+\s*/, '').replace(/\*\*|__/g, '').trim().slice(0, 120);
  const shortLabel = s => String(s).split(/[:\-–—(]/)[0].trim() || String(s).slice(0, 40);

  let AN = { text: null, an: null };
  function analyze(text) {
    if (AN.text === text) return AN.an;
    const lines = String(text || '').split(/\r?\n/), N = lines.length;
    const heads = [], pages = [], cum = [0];
    lines.forEach((ln, i) => {
      cum.push(cum[i] + ln.length + 1);
      const line = i + 1;
      const pm = ln.match(PAGERE);
      if (pm) { pages.push({ line, page: +pm[1] }); return; }
      if (!ln.trim() || ln.length > 160) return;
      let m = ln.match(KWRE);
      if (m) {
        const tok = m[2];
        if (/^[A-Za-z]+$/.test(tok) && tok !== tok.toUpperCase()) { m = null; }
        else {
          const kw = m[1].toLowerCase(), num = /^\d+$/.test(tok) ? +tok : romanToInt(tok);
          heads.push({ line, level: KW1RE.test(kw) ? 1 : 2, type: 'kw', text: clean(ln), num: String(num) });
          return;
        }
      }
      m = ln.match(NUMRE);
      if (m) { heads.push({ line, level: m[1].split('.').length, type: 'num', text: clean(ln), num: m[1] }); return; }
      m = ln.match(MDRE);
      if (m) { heads.push({ line, level: m[1].length, type: 'md', text: clean(ln), num: null }); return; }
      if (isCaps(ln)) heads.push({ line, level: 3, type: 'caps', text: clean(ln), num: null });
    });
    heads.forEach((h, i) => { h.id = i + 1; });
    const stack = [];
    heads.forEach(h => {
      while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop().end = h.line - 1;
      stack.push(h);
    });
    while (stack.length) stack.pop().end = N;
    heads.forEach(h => { h.chars = cum[h.end] - cum[h.line - 1]; });
    const byId = {}; heads.forEach(h => { byId[h.id] = h; });

    const main = heads.filter(h => h.type !== 'caps'), pool = main.length ? main : heads;
    const top = pool.length ? Math.min(...pool.map(h => h.level)) : 0;
    const seen = {};
    const secs = pool.filter(h => h.level === top).map((h, i) => {
      const base = h.text, c = seen[base] = (seen[base] || 0) + 1;
      return {
        id: h.id, key: base + '#' + c, label: h.text.slice(0, 90), line: h.line, end: h.end,
        numStr: h.num || String(i + 1),
        text: lines.slice(h.line - 1, h.end).join('\n').trim()
      };
    }).filter(s => s.text.length > 0);

    const an = { lines, heads, byId, pages, secs, N, chars: text.length, maxPage: pages.length ? Math.max(...pages.map(p => p.page)) : 0 };
    AN = { text, an };
    return an;
  }

  function outlineFor(an, max) {
    let hs = an.heads, truncated = false;
    if (hs.length > max) {
      hs = [...hs].sort((a, b) => a.level - b.level || a.id - b.id).slice(0, max).sort((a, b) => a.id - b.id);
      truncated = true;
    }
    return { truncated, items: hs.map(h => ({ id: h.id, line: h.line, end: h.end, level: h.level, text: h.text.slice(0, 80) })) };
  }
  function sampleFor(an) {
    const out = [];
    for (let i = 0; i < an.lines.length && out.length < 30; i++) {
      const t = an.lines[i].trim();
      if (t && !PAGERE.test(t)) out.push({ line: i + 1, text: t.slice(0, 110) });
    }
    return out;
  }

  /* ===================================================================
   *  TRẠNG THÁI PHẠM VI (mỗi tài liệu một state, tách danh sách gốc khỏi danh sách đang chọn)
   * =================================================================== */
  const isSaved = id => id !== 'draft' && id !== 'tmp';
  const savedScopes = () => ld('docScopes', {});
  function getScope(id) {
    if (!S.scopes[id]) {
      const st = isSaved(id) ? savedScopes()[id] : null;
      S.scopes[id] = {
        selKeys: st && Array.isArray(st.selKeys) ? st.selKeys : null,
        knownKeys: st && Array.isArray(st.knownKeys) ? st.knownKeys : [],
        applied: false, quick: '', req: (st && st.req) || '', ex: null, busy: '', run: 0, pend: []
      };
    }
    return S.scopes[id];
  }
  /* Đồng bộ danh sách mục: lần đầu chọn tất cả; sau đó CHỈ thêm mục mới xuất hiện, không bao giờ khôi phục mục đã bỏ chọn. */
  function syncSel(sc, secs) {
    const keys = secs.map(s => s.key);
    if (sc.selKeys === null) sc.selKeys = [...keys];
    else {
      const known = new Set(sc.knownKeys);
      keys.forEach(k => { if (!known.has(k)) sc.selKeys.push(k); });
      sc.selKeys = sc.selKeys.filter(k => keys.includes(k));
    }
    sc.knownKeys = [...keys];
  }
  function persist(id) {
    const sc = getScope(id);
    if (isSaved(id)) { const all = savedScopes(); all[id] = { selKeys: sc.selKeys, knownKeys: sc.knownKeys, req: sc.req }; sv('docScopes', all); }
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
  function sigOf(text) {
    const t = String(text || '').trim();
    let h = 5381;
    for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
    return t.length + ':' + (h >>> 0);
  }
  const exStale = (sc, text) => !!(sc.ex && sc.ex.status === 'done' && sc.ex.sig !== sigOf(text));
  const stripPages = t => String(t).replace(PAGE_STRIP, '').replace(/\n{3,}/g, '\n\n').trim();

  /* Nội dung THỰC TẾ sẽ gửi cho AI tạo quiz — dùng chung cho xem trước và build() */
  function scopedText(id, full) {
    const sc = getScope(id), an = analyze(full);
    if (sc.ex && sc.ex.status === 'done') {
      if (exStale(sc, full)) return { stale: true };
      const t = stripPages(sc.ex.text);
      return t ? { text: t, labels: sc.ex.picks.join(', ') } : { empty: true };
    }
    if (!an.secs.length) return { text: stripPages(full), labels: '' };
    syncSel(sc, an.secs);
    const sel = an.secs.filter(s => sc.selKeys.includes(s.key));
    if (!sel.length) return { empty: true };
    if (sel.length === an.secs.length) return { text: stripPages(full), labels: '' };
    return { text: stripPages(sel.map(s => s.text).join('\n\n')), labels: sel.map(s => shortLabel(s.label)).join(', ') };
  }

  /* ---------- Nhập nhanh "2-4", "2, 5" ---------- */
  function parseQuick(v, secs) {
    const t = String(v || '').trim().replace(/\s*([-–—])\s*/g, '$1');
    if (/^(all|tat ca|tất cả)$/i.test(t)) return { idx: secs.map((_, i) => i) };
    const avail = secs.map(s => s.numStr);
    const want = new Set(), missing = [];
    const toks = t.split(/[,;\s]+/).filter(Boolean);
    if (!toks.length) return { error: 'Chưa nhập gì. Hãy nhập dạng 2-4 hoặc 2, 5.' };
    for (const p of toks) {
      let m = p.match(/^(\d+)[-–—](\d+)$/);
      if (m) {
        let a = +m[1], b = +m[2]; if (a > b) [a, b] = [b, a];
        const ints = avail.filter(x => /^\d+$/.test(x)).map(Number);
        if (!ints.length || a > Math.max(...ints) || b < Math.min(...ints)) { missing.push(p); continue; }
        for (let x = a; x <= Math.min(b, a + 2000); x++) if (avail.includes(String(x))) want.add(String(x));
        continue;
      }
      if (/^\d+(?:\.\d+)*$/.test(p)) { if (avail.includes(p)) want.add(p); else missing.push(p); continue; }
      return { error: 'Cú pháp không hợp lệ: “' + p + '”. Hãy nhập dạng 2-4 hoặc 2, 5.' };
    }
    if (missing.length) return { error: 'Không có mục số ' + missing.join(', ') + '. Các mục hiện có: ' + avail.join(', ') + '.' };
    const idx = []; secs.forEach((s, i) => { if (want.has(s.numStr)) idx.push(i); });
    if (!idx.length) return { error: 'Không có mục nào khớp. Các mục hiện có: ' + avail.join(', ') + '.' };
    return { idx };
  }

  /* ===================================================================
   *  GỌI BACKEND TRÍCH XUẤT
   * =================================================================== */
  async function api(body, timeout) {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), timeout || 45000);
    try {
      const res = await fetch('/.netlify/functions/extract-content', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 404) throw Error('Chưa có hàm extract-content trên Netlify. Hãy thêm file netlify/functions/extract-content.js rồi deploy lại.');
      if (!res.ok) throw Error(data.error || 'Máy chủ chưa xử lý được yêu cầu (' + res.status + ').');
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw Error('Máy chủ phản hồi quá lâu. Hãy thử lại.');
      if (e instanceof TypeError) throw Error('Không thể kết nối máy chủ. Kiểm tra mạng hoặc Netlify Functions.');
      throw e;
    } finally { clearTimeout(tm); }
  }
  const sleep = ms => new Promise(ok => setTimeout(ok, ms));
  async function apiRetry(body) { try { return await api(body); } catch (e) { await sleep(1500); return api(body); } }

  /* Chuyển một mục của kế hoạch thành khoảng dòng (1-based) */
  function resolveItem(an, it) {
    const N = an.N;
    if (it.all) return { from: 1, to: N };
    if (Number.isInteger(it.id)) { const h = an.byId[it.id]; return h ? { from: h.line, to: h.end } : { skip: 1 }; }
    if (it.fromId != null) {
      const a = an.byId[it.fromId], b = an.byId[it.toId];
      if (!a || !b) return { skip: 1 };
      const from = a.line, to = it.toInclusive ? b.end : b.line - 1;
      return to >= from ? { from, to } : { error: 'Khoảng “từ … đến …” không hợp lệ: điểm kết thúc nằm trước điểm bắt đầu.' };
    }
    if (it.fromLine != null) return { from: Math.max(1, it.fromLine), to: Math.min(N, it.toLine) };
    if (it.fromPage != null) {
      if (!an.pages.length) return { error: 'Tài liệu này không có thông tin số trang (chỉ file PDF tải lên mới có). Hãy yêu cầu theo tiêu đề hoặc nội dung.' };
      if (it.fromPage > an.maxPage) return { error: 'Tài liệu chỉ có ' + an.maxPage + ' trang.' };
      const start = an.pages.find(p => p.page >= it.fromPage), next = an.pages.find(p => p.page > it.toPage);
      return { from: start.line, to: next ? next.line - 1 : N };
    }
    return { skip: 1 };
  }

  async function runPool(tasks, conc, fn) {
    let next = 0, err = null; const out = [];
    async function w() { while (next < tasks.length && !err) { const i = next++; try { out[i] = await fn(tasks[i], i); } catch (e) { err = e; } } }
    await Promise.all(Array.from({ length: conc }, w));
    if (err) throw err;
    return out;
  }

  /* Thực thi kế hoạch trên văn bản gốc: cắt nguyên văn theo dòng, lọc từng dòng nếu cần (AI chỉ trả số dòng) */
  async function executePlan(id, text, plan, req, run, say) {
    const sc = getScope(id), an = analyze(text), N = an.N;
    const alive = () => { if (sc.run !== run) throw Error('__cancel'); };
    const inc = new Uint8Array(N);
    const apply = (items, val) => {
      for (const it of items || []) {
        const r = resolveItem(an, it);
        if (r.error) throw Error(r.error);
        if (r.skip) continue;
        for (let i = r.from - 1; i <= r.to - 1 && i < N; i++) if (i >= 0) inc[i] = val;
      }
    };
    apply(plan.select, 1); apply(plan.exclude, 0);
    let any = false; for (let i = 0; i < N; i++) if (inc[i] && an.lines[i].trim() && !PAGERE.test(an.lines[i])) { any = true; break; }
    const hintTitles = an.secs.slice(0, 6).map(s => s.label);
    if (!any) return { status: 'not_found', message: 'Phạm vi bạn yêu cầu không có nội dung nào.', suggestions: hintTitles, req };

    const picksOf = flags => {
      const hit = an.secs.filter(s => { for (let i = s.line - 1; i < s.end; i++) if (flags[i]) return true; return false; });
      return hit.length ? hit.map(s => shortLabel(s.label)) : ['Phần đã chọn'];
    };
    const joinLines = idxs => {
      let out = '', prev = -10;
      idxs.forEach(i => { out += (out ? (i - prev <= 2 ? '\n' : '\n\n') : '') + an.lines[i]; prev = i; });
      return out;
    };

    /* Chỉ chọn theo tiêu đề / trang / dòng: cắt nguyên văn, không cần AI lọc thêm */
    if (!plan.scan) {
      const idxs = []; for (let i = 0; i < N; i++) if (inc[i] && !PAGERE.test(an.lines[i])) idxs.push(i);
      let t = ''; let prev = -10;
      idxs.forEach(i => { t += (t ? (i - prev === 1 ? '\n' : '\n\n') : '') + an.lines[i]; prev = i; });
      t = t.replace(/\n{3,}/g, '\n\n').trim();
      return { status: 'done', req, sig: sigOf(text), text: t, picks: picksOf(inc), lines: idxs.length, chars: t.length, ai: false };
    }

    /* Cần lọc nội dung từng dòng: chia đoạn nhỏ, AI trả về số dòng cần giữ */
    const cand = []; for (let i = 0; i < N; i++) if (inc[i] && an.lines[i].trim() && !PAGERE.test(an.lines[i])) cand.push(i);
    const chunks = []; let cur = [], size = 0;
    cand.forEach(i => { const len = Math.min(an.lines[i].length, 400); if (cur.length && (size + len > 4200 || cur.length >= 120)) { chunks.push(cur); cur = []; size = 0; } cur.push(i); size += len; });
    if (cur.length) chunks.push(cur);
    if (chunks.length > 150) throw Error('Phạm vi quá lớn để lọc (' + chunks.length + ' đoạn). Hãy thu hẹp yêu cầu, ví dụ chỉ lấy một vài ngày/chương.');

    const limit = plan.scan.limit || null, kept = new Set();
    let itemsTotal = 0, done = 0;
    const doChunk = async (chunk, ci, limitLeft) => {
      alive();
      const r = await apiRetry({ action: 'filter', instruction: plan.scan.instruction, limitLeft, lines: chunk.map(i => ({ n: i + 1, t: an.lines[i].trim().slice(0, 400) })) });
      alive();
      const set = new Set(chunk.map(i => i + 1));
      const keep = [];
      (r.keep || []).forEach(([a, b]) => { for (let n = a; n <= b; n++) if (set.has(n)) keep.push(n - 1); });
      done++; say('Đang lọc nội dung theo yêu cầu… (' + done + '/' + chunks.length + ')');
      return { keep, items: +r.items || 0 };
    };
    if (limit) {
      for (let ci = 0; ci < chunks.length && itemsTotal < limit; ci++) {
        const r = await doChunk(chunks[ci], ci, limit - itemsTotal);
        r.keep.forEach(i => kept.add(i)); itemsTotal += r.items;
      }
    } else {
      const res = await runPool(chunks, 3, (c, ci) => doChunk(c, ci, null));
      res.forEach(r => r.keep.forEach(i => kept.add(i)));
    }
    if (!kept.size) return { status: 'not_found', message: 'Không có nội dung nào trong phạm vi đã chọn khớp với yêu cầu của bạn.', suggestions: hintTitles, req };

    /* Giữ ngữ cảnh: thêm các tiêu đề chứa nội dung đã giữ (nếu tiêu đề đó nằm trong phạm vi được chọn) */
    const keepFlags = new Uint8Array(N);
    kept.forEach(i => { keepFlags[i] = 1; });
    an.heads.forEach(h => {
      if (!inc[h.line - 1]) return;
      for (let i = h.line; i <= h.end && i <= N; i++) if (kept.has(i - 1)) { keepFlags[h.line - 1] = 1; break; }
    });
    const idxs = []; for (let i = 0; i < N; i++) if (keepFlags[i]) idxs.push(i);
    const t = joinLines(idxs).trim();
    return { status: 'done', req, sig: sigOf(text), text: t, picks: picksOf(keepFlags), lines: idxs.length, chars: t.length, ai: true, limit };
  }

  /* Chạy một thao tác dài với trạng thái bận / hủy / lỗi */
  async function job(id, fn) {
    const sc = getScope(id);
    if (sc.busy) return;
    const run = ++sc.run;
    sc.busy = 'Đang phân tích yêu cầu…'; sc.ex = null; refresh(id);
    const say = msg => { if (sc.run === run) { sc.busy = msg; document.querySelectorAll('[data-sc="' + id + '"] .sc-busy-t').forEach(el => { el.textContent = msg; }); } };
    try { sc.ex = await fn(run, say); }
    catch (e) { if (e.message !== '__cancel') sc.ex = { status: 'error', message: e.message || 'Có lỗi khi trích xuất.' }; }
    finally { if (sc.run === run) { sc.busy = ''; refresh(id); } }
  }

  window.scExtract = function (id) {
    const sc = getScope(id), text = scText(id), req = String(sc.req || '').trim();
    if (text.trim().length < 50) { toast('Tài liệu quá ngắn.', 'e'); return; }
    if (!req) { toast('Hãy nhập yêu cầu: bạn muốn lấy phần nội dung nào?', 'e'); return; }
    job(id, async (run, say) => {
      const an = analyze(text), ol = outlineFor(an, 250);
      say('Đang nhận diện cấu trúc và tìm phần bạn yêu cầu…');
      const r = await api({ action: 'plan', request: req, outline: ol.items, truncated: ol.truncated, sample: sampleFor(an), stats: { lines: an.N, chars: an.chars, pages: an.maxPage } });
      if (sc.run !== run) throw Error('__cancel');
      const plan = r.plan;
      if (plan.status === 'clarify') {
        sc.pend = [];
        return { status: 'clarify', req, message: plan.message, suggestions: plan.suggestions, candidates: plan.candidates, plan };
      }
      if (plan.status === 'not_found') return { status: 'not_found', req, message: plan.message || 'Không tìm thấy phần bạn yêu cầu.', suggestions: plan.suggestions.length ? plan.suggestions : an.secs.slice(0, 6).map(s => s.label) };
      say('Đang trích xuất nội dung…');
      return executePlan(id, text, plan, req, run, say);
    });
  };
  window.scPickCand = function (id) {
    const sc = getScope(id), ex = sc.ex, text = scText(id);
    if (!ex || ex.status !== 'clarify') return;
    if (!sc.pend.length) { toast('Hãy chọn ít nhất một mục.', 'e'); return; }
    const plan = { ...ex.plan, status: 'ok', select: sc.pend.map(i => ({ id: i })) }, req = ex.req;
    job(id, (run, say) => executePlan(id, text, plan, req, run, say));
  };
  window.scStop = function (id) { const sc = getScope(id); sc.run++; sc.busy = ''; refresh(id); toast('Đã dừng trích xuất.'); };
  window.scExClear = function (id) { const sc = getScope(id); sc.ex = null; sc.pend = []; refresh(id); };
  window.scReq = function (id, v) { const sc = getScope(id); sc.req = v; persist(id); };
  window.scSetReq = function (id, v) {
    const sc = getScope(id); sc.req = v; persist(id);
    document.querySelectorAll('[data-sc="' + id + '"] textarea.sc-req').forEach(el => { el.value = v; el.focus(); });
  };
  window.scExEdit = function (id, v) {
    const sc = getScope(id); if (!sc.ex || sc.ex.status !== 'done') return;
    sc.ex.text = v; sc.ex.chars = v.length;
    document.querySelectorAll('[data-sc="' + id + '"] .sc-cnt').forEach(el => { el.textContent = v.length.toLocaleString('vi-VN') + ' ký tự (đã chỉnh sửa)'; });
  };
  window.scCand = function (id, i, on) { const sc = getScope(id); sc.pend = on ? [...new Set([...sc.pend, i])] : sc.pend.filter(x => x !== i); };

  /* ===================================================================
   *  CHỌN THỦ CÔNG THEO MỤC
   * =================================================================== */
  window.scToggle = function (id, i) {
    const text = scText(id), sc = getScope(id), an = analyze(text); syncSel(sc, an.secs);
    const s = an.secs[i]; if (!s) return;
    sc.selKeys = sc.selKeys.includes(s.key) ? sc.selKeys.filter(k => k !== s.key) : [...sc.selKeys, s.key];
    sc.quick = ''; persist(id); refresh(id);
  };
  window.scAll = function (id, on) {
    const sc = getScope(id), an = analyze(scText(id)); syncSel(sc, an.secs);
    sc.selKeys = on ? an.secs.map(s => s.key) : []; sc.applied = false; sc.quick = ''; persist(id); refresh(id);
  };
  window.scApply = function (id, val) {
    const text = scText(id), sc = getScope(id), an = analyze(text); syncSel(sc, an.secs);
    const v = String(val || '').trim();
    if (v) {
      const r = parseQuick(v, an.secs);
      if (r.error) { toast(r.error, 'e'); return; }
      sc.selKeys = r.idx.map(i => an.secs[i].key); sc.quick = v;
    }
    if (!sc.selKeys.length) { toast('Hãy chọn ít nhất 1 mục trước khi áp dụng.', 'e'); return; }
    sc.applied = true; persist(id); refresh(id);
  };
  window.scEdit = function (id) { const sc = getScope(id); sc.applied = false; refresh(id); };

  /* ===================================================================
   *  GIAO DIỆN
   * =================================================================== */
  function manualBlock(id, sc, an, text) {
    const secs = an.secs, selSet = new Set(sc.selKeys);
    const sel = secs.filter(s => selSet.has(s.key)), chars = sel.reduce((a, s) => a + s.text.length, 0);
    const sendText = scopedText(id, text), shown = sendText.text || '';
    let h = '<div class="sc-sep">Hoặc chọn thủ công theo các mục đã nhận diện (' + secs.length + ' mục)</div>';
    if (sc.applied && sel.length) {
      h += `<div class="sc-list">${secs.map((s, i) => selSet.has(s.key) ? `<div class="sc-it on"><b>${esc(s.label)}</b><span>${s.text.length.toLocaleString('vi-VN')} ký tự</span><button type="button" class="sc-x" aria-label="Bỏ mục này" title="Bỏ mục này" onclick="scToggle('${id}',${i})">✕</button></div>` : '').join('')}</div>
        <div class="sc-row"><button type="button" class="btn sm o" onclick="scEdit('${id}')">Chỉnh sửa lựa chọn</button></div>`;
    } else {
      h += `<div class="sc-row">
        <button type="button" class="btn sm o" onclick="scAll('${id}',true)">Chọn tất cả</button>
        <button type="button" class="btn sm o" onclick="scAll('${id}',false)">Bỏ chọn</button>
        <input type="text" value="${esc(sc.quick || '')}" placeholder="Nhập nhanh: 2-4 hoặc 2, 5" aria-label="Nhập nhanh các mục" onkeydown="if(event.key==='Enter'){scApply('${id}',this.value)}">
        <button type="button" class="btn sm" onclick="scApply('${id}',this.previousElementSibling.value)">Áp dụng</button></div>
        <div class="sc-list">${secs.map((s, i) => `<label class="sc-it ${selSet.has(s.key) ? 'on' : ''}"><input type="checkbox" ${selSet.has(s.key) ? 'checked' : ''} onchange="scToggle('${id}',${i})"><b>${esc(s.label)}</b><span>${s.text.length.toLocaleString('vi-VN')} ký tự</span></label>`).join('')}</div>`;
    }
    h += `<p class="sc-sum">Đã chọn <b>${sel.length}/${secs.length}</b> mục · ${chars.toLocaleString('vi-VN')} ký tự${sel.length === 0 ? ' — <span class="bad">hãy chọn ít nhất 1 mục</span>' : ' sẽ được gửi cho AI'}</p>
      <details style="margin-top:6px"><summary>Xem trước nội dung sẽ gửi cho AI</summary><textarea class="sc-prev" readonly>${esc(shown.slice(0, 20000))}${shown.length > 20000 ? '\n… (hiển thị 20.000 ký tự đầu)' : ''}</textarea></details>`;
    return h;
  }

  function panel(id) {
    const text = scText(id);
    if (text.trim().length < 50) return `<div data-sc="${id}"></div>`;
    const sc = getScope(id), an = analyze(text);
    syncSel(sc, an.secs);
    const ex = sc.ex, stale = exStale(sc, text), busy = !!sc.busy;
    let h = `<div class="exp sc" data-sc="${id}"><div class="sc-h"><b>Phạm vi tạo câu hỏi</b><span class="mu">${esc(scName(id))}</span></div>
      <label class="sc-lb" for="scr-${id}">Bạn muốn lấy phần nội dung nào để tạo quiz?</label>
      <textarea id="scr-${id}" class="sc-req" rows="2" ${busy ? 'disabled' : ''} placeholder="Ví dụ: Lấy toàn bộ từ vựng của Ngày 1 thuộc chủ đề Accounting, không lấy ví dụ" oninput="scReq('${id}',this.value)" onkeydown="if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){scExtract('${id}')}">${esc(sc.req)}</textarea>
      <div class="sc-row"><button type="button" class="btn sm" ${busy ? 'disabled' : ''} onclick="scExtract('${id}')">🔎 Trích xuất</button>${busy ? `<button type="button" class="btn sm o" onclick="scStop('${id}')">Dừng</button>` : ''}<span class="mu" style="font-size:12px">Ctrl + Enter · nhập tiếng Việt hoặc tiếng Anh thông thường</span></div>
      ${!ex && !busy ? `<div class="sc-chips">${EXAMPLES.map(e => `<button type="button" class="sc-chip" onclick="scSetReq('${id}',this.textContent)">${esc(e)}</button>`).join('')}</div>` : ''}`;
    if (busy) h += `<div class="sc-busy" role="status"><i class="sc-spin"></i><span class="sc-busy-t">${esc(sc.busy)}</span></div>`;

    let manual = true;
    if (ex && ex.status === 'done' && !stale) {
      manual = false;
      h += `<div class="sc-card ok"><div class="sc-h"><b>✔ Đã trích xuất${ex.ai ? ' (có lọc nội dung bằng AI)' : ''}</b><span class="mu sc-cnt">${ex.chars.toLocaleString('vi-VN')} ký tự · ${ex.lines} dòng</span></div>
        <p class="mu" style="margin:4px 0 6px;font-size:13px">Yêu cầu: “${esc(ex.req)}”</p>
        <div>${ex.picks.map(p => `<span class="sc-tag">${esc(p)}</span>`).join('')}</div>
        ${ex.limit ? `<p class="mu" style="margin:4px 0;font-size:12px">Giới hạn ${ex.limit} mục — kết quả được đếm theo mục từ vựng/định nghĩa.</p>` : ''}
        <details open><summary>Xem trước nội dung sẽ gửi cho AI (có thể chỉnh sửa)</summary><textarea class="sc-prev" oninput="scExEdit('${id}',this.value)">${esc(ex.text)}</textarea></details>
        <div class="sc-row"><button type="button" class="btn sm o" onclick="scExClear('${id}')">Hủy trích xuất · quay lại chọn thủ công</button></div></div>`;
    } else if (stale) {
      h += `<div class="wn">Nội dung tài liệu đã thay đổi nên kết quả trích xuất cũ không còn đúng và sẽ không được dùng. Hãy bấm “Trích xuất” lại hoặc hủy kết quả cũ.</div><div class="sc-row"><button type="button" class="btn sm o" onclick="scExClear('${id}')">Hủy kết quả cũ</button></div>`;
    } else if (ex && ex.status === 'clarify') {
      h += `<div class="sc-card"><b>❓ ${esc(ex.message)}</b>${ex.candidates.length ? `<div class="sc-list">${ex.candidates.map(cid => { const hd = an.byId[cid]; return hd ? `<label class="sc-it"><input type="checkbox" ${sc.pend.includes(cid) ? 'checked' : ''} onchange="scCand('${id}',${cid},this.checked)"><b>${esc(hd.text)}</b><span>${hd.chars.toLocaleString('vi-VN')} ký tự</span></label>` : ''; }).join('')}</div><div class="sc-row"><button type="button" class="btn sm" onclick="scPickCand('${id}')">Dùng các mục đã chọn</button></div>` : ''}
        ${ex.suggestions.length ? `<div class="sc-chips">${ex.suggestions.map(s => `<button type="button" class="sc-chip" onclick="scSetReq('${id}','Lấy nội dung ${esc(s).replace(/'/g, '’')}')">${esc(s)}</button>`).join('')}</div>` : ''}<p class="mu" style="margin:4px 0 0;font-size:12px">Hoặc sửa lại yêu cầu ở ô phía trên rồi bấm “Trích xuất”.</p></div>`;
    } else if (ex && (ex.status === 'not_found' || ex.status === 'error')) {
      h += `<div class="err">${esc(ex.message)}</div>${ex.suggestions && ex.suggestions.length ? `<div class="mu" style="font-size:13px">Có phải bạn muốn lấy:</div><div class="sc-chips">${ex.suggestions.map(s => `<button type="button" class="sc-chip" onclick="scSetReq('${id}','Lấy nội dung ${esc(s).replace(/'/g, '’')}')">${esc(s)}</button>`).join('')}</div>` : ''}`;
    }
    if (manual) {
      if (an.secs.length) h += manualBlock(id, sc, an, text);
      else h += '<p class="mu" style="margin:10px 0 0;font-size:13px">Không nhận diện được tiêu đề/mục rõ ràng, nên toàn bộ tài liệu sẽ được dùng nếu bạn không nhập yêu cầu. Hãy mô tả phần cần lấy ở ô phía trên để AI tìm giúp.</p>';
    }
    return h + '</div>';
  }
  function refresh(id) {
    document.querySelectorAll('[data-sc="' + id + '"]').forEach(el => { el.outerHTML = panel(id); });
  }
  window.__scRefresh = refresh;

  const cloneScope = s => ({ selKeys: s.selKeys === null ? null : [...s.selKeys], knownKeys: [...s.knownKeys], applied: false, quick: '', req: s.req, ex: s.ex, busy: '', run: 0, pend: [] });

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
  V.doc = function () { vDoc(); const c = $('#app .card'); if (c && S.did) c.insertAdjacentHTML('afterend', panel(S.did)); };

  const vMk = V.mk;
  V.mk = function () {
    vMk();
    try {
      const nm = $('#examFileNames');
      if (nm && S.examFiles && S.examFiles.length) examChips();
      const pn = $('#pn'), m = S.mode;
      if (!pn || !['ai', 'game', 'exam'].includes(m)) return;
      if (m === 'game' && !pn.querySelector('.qv-doc')) return;
      if (m === 'exam' && ((S.examSource || 'doc') === 'bank' || (S.examFiles && S.examFiles.length))) return;
      const ids = (S.sel || []).filter(id => (id === 'tmp' && S.temp) || docs().some(x => x.id === id));
      if (!ids.length) return;
      const html = ids.map(panel).join('');
      if (m === 'game') { const a = pn.querySelector('.qv-source'); a && a.insertAdjacentHTML('afterend', html); }
      else if (m === 'ai') { const a = pn.querySelectorAll('.exp')[1]; a ? a.insertAdjacentHTML('beforebegin', html) : ($('#go') && $('#go').insertAdjacentHTML('beforebegin', html)); }
      else { const a = $('#go'); a && a.insertAdjacentHTML('beforebegin', html); }
    } catch (e) { console.warn('scope mount', e); }
  };

  /* ===================================================================
   *  TẢI / XÓA FILE
   * =================================================================== */
  const _readF = readF;
  readF = async function (f, set) {
    const ext = f.name.split('.').pop().toLowerCase();
    if (ext !== 'pdf') return _readF(f, set);
    if (f.size > MAXMB * 1048576) throw Error('File quá lớn (tối đa ' + MAXMB + ' MB).');
    if (!f.size) throw Error('File trống.');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const p = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
    let t = '';
    for (let i = 1; i <= p.numPages; i++) {
      set('Đang đọc trang ' + i + '/' + p.numPages);
      const tc = await (await p.getPage(i)).getTextContent();
      t += '=== Trang ' + i + ' ===\n' + tc.items.map(x => x.str + (x.hasEOL ? '\n' : ' ')).join('') + '\n';
    }
    if (t.replace(/=== Trang \d+ ===/g, '').trim().length < 20) throw Error('PDF này là bản scan. Hãy chụp từng trang thành ảnh để dùng OCR hoặc dán văn bản.');
    return t;
  };

  upl = async function (fs) {
    if (S.uploading) return;
    S.uploading = true; keep(); $('#er').innerHTML = '';
    for (const f of [...fs]) {
      const e = { n: f.name, t: (f.name.split('.').pop() || '?').toUpperCase(), s: 'Đang tải lên...' };
      S.files.push(e); fl();
      try {
        const t = (await readF(f, s => { e.s = s; fl(); })).trim();
        if (!t) throw Error('Không đọc được nội dung.');
        e.txt = t;
        const x = $('#tx'); x.value = (x.value ? x.value + '\n\n' : '') + t;
        const dn = $('#dn'); if (!dn.value) dn.value = f.name.replace(/\.[^.]+/, '');
        const g = guess(f.name);
        if (!$('#sj').value && g.s) $('#sj').value = g.s;
        if (!$('#tg').value && g.c) $('#tg').value = g.c;
        e.s = 'Hoàn tất'; toast('Đã đọc xong: ' + f.name, 's');
      } catch (err) {
        e.s = 'Lỗi'; $('#er').innerHTML += `<div class="err"><b>${esc(f.name)}:</b> ${esc(err.message)}</div>`;
      }
      fl();
    }
    $('#fi').value = ''; S.uploading = false; keep(); fl(); refresh('draft');
  };

  const _fl = fl;
  fl = function () {
    _fl();
    const box = $('#fl'); if (!box) return;
    box.querySelectorAll(':scope > .f').forEach((row, i) => {
      const e = S.files[i]; if (!e || (e.s !== 'Hoàn tất' && !String(e.s).startsWith('Lỗi'))) return;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn sm o d'; b.textContent = 'Xóa'; b.setAttribute('aria-label', 'Xóa file ' + e.n);
      b.onclick = () => scFileDel(i); row.appendChild(b);
    });
    if (S.files.length > 1 && !S.uploading) {
      box.insertAdjacentHTML('beforeend', '<div class="sc-row"><button type="button" class="btn sm o d" onclick="scClearAll()">Xóa tất cả file đã tải</button></div>');
    }
  };
  window.scFileDel = function (i) {
    const e = S.files[i], ta = $('#tx'); if (!e) return;
    if (e.txt && ta) {
      const p = ta.value.indexOf(e.txt);
      if (p >= 0) {
        let a = p, b = p + e.txt.length;
        if (ta.value.slice(b, b + 2) === '\n\n') b += 2; else if (a >= 2 && ta.value.slice(a - 2, a) === '\n\n') a -= 2;
        ta.value = ta.value.slice(0, a) + ta.value.slice(b);
      } else toast('Nội dung file này đã bị chỉnh sửa nên không tự gỡ được. Hãy xóa phần đó trong ô nội dung.', 'e');
    }
    S.files.splice(i, 1);
    const dn = $('#dn');
    if (dn && !S.files.length && dn.value === e.n.replace(/\.[^.]+/, '')) dn.value = '';
    keep(); fl(); refresh('draft');
    toast('Đã xóa file: ' + e.n, 's');
  };
  window.scClearAll = async function () {
    if (!await ask('Xóa tất cả file đã tải và nội dung trong ô bên dưới?', 'Xóa tất cả')) return;
    const ta = $('#tx'), dn = $('#dn');
    if (ta) ta.value = '';
    if (dn && S.files.some(f => dn.value === f.n.replace(/\.[^.]+/, ''))) dn.value = '';
    S.files = []; delete S.scopes.draft; keep(); fl(); refresh('draft'); toast('Đã xóa tất cả file đã tải.', 's');
  };

  /* Luyện thi: xóa từng file đã chọn */
  function examChips() {
    const nm = $('#examFileNames'); if (!nm) return;
    nm.innerHTML = (S.examFiles || []).map((f, i) => `<span class="sc-tag">${esc(f.name)} <button type="button" class="sc-x" aria-label="Xóa ${esc(f.name)}" onclick="scExamDel(${i})">✕</button></span>`).join(' ');
  }
  const _sef = selectExamFiles;
  selectExamFiles = function (files) { _sef(files); if (S.examFiles && S.examFiles.length) examChips(); };
  window.scExamDel = function (i) { S.examFiles.splice(i, 1); V.mk(); };
  const _uef = uploadExamFiles;
  uploadExamFiles = async function (files) { delete S.scopes.tmp; return _uef(files); };

  /* ---------- Đồng bộ phạm vi khi lưu / dùng tài liệu ---------- */
  const _useDraftNow = useDraftNow;
  useDraftNow = async function (mode) { S.scopes.tmp = cloneScope(getScope('draft')); return _useDraftNow(mode); };
  const _useTemp = useTemp;
  useTemp = function () { S.scopes.tmp = cloneScope(getScope('draft')); const r = _useTemp(); delete S.scopes.draft; return r; };
  const _saveDoc = saveDoc;
  saveDoc = function (then) {
    const before = docs().map(x => x.id), did = S.draft && S.draft.id, sc = cloneScope(getScope('draft'));
    const r = _saveDoc(then);
    const nd = did || (docs().find(x => !before.includes(x.id)) || {}).id;
    if (nd && docs().some(x => x.id === nd)) { S.scopes[nd] = sc; persist(nd); delete S.scopes.draft; }
    return r;
  };
  const _saveTemp = saveTemp;
  saveTemp = function (e) {
    const before = docs().map(x => x.id), sc = cloneScope(getScope('tmp'));
    const r = _saveTemp(e);
    const nd = (docs().find(x => !before.includes(x.id)) || {}).id;
    if (nd) { S.scopes[nd] = sc; persist(nd); }
    return r;
  };
  const _openDoc = openDoc;
  openDoc = function (id) { S.scopes.draft = cloneScope(getScope(id)); return _openDoc(id); };

  /* ===================================================================
   *  GAME QUIZ: số câu tùy ý
   * =================================================================== */
  const pGame = P.game;
  P.game = function () {
    const h = pGame(), n = Math.min(MAX_GAME, Math.max(1, parseInt(S.f.n) || 10));
    const btns = [5, 10, 20, 30, 50, 100].map(v => `<button class="${n === v ? 'on' : ''}" onclick="S.f.n=${v};V.mk()">${v}</button>`).join('');
    const ctl = `<label>Số câu</label><div class="qv-seg" style="flex-wrap:wrap">${btns}</div>
      <div class="row" style="margin-top:8px"><input type="number" min="1" max="${MAX_GAME}" value="${n}" style="width:100px" aria-label="Số câu tùy chọn" onchange="S.f.n=Math.min(${MAX_GAME},Math.max(1,parseInt(this.value)||10));V.mk()"><span class="mu">câu · tối đa ${MAX_GAME}</span></div>
      ${n > 30 ? '<p class="mu" style="margin:6px 0 0;font-size:12px">Số câu lớn được tạo theo từng đợt nên sẽ mất vài phút.</p>' : ''}`;
    return h.replace(/<label>Số câu<\/label><div class="qv-seg">[\s\S]*?<\/div>/, () => ctl);
  };

  /* ===================================================================
   *  CHỐNG TRÙNG CÂU HỎI
   * =================================================================== */
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
    const ca = aiNorm(a.o[a.c]), cb = aiNorm(b.o[b.c]);
    /* Hai câu cùng khuôn mẫu ("Từ X có nghĩa là gì?") chỉ khác từ X không phải câu trùng:
       đề giống nhau chỉ tính là trùng khi các lựa chọn cũng chồng lấn. */
    const oa = new Set(a.o.map(aiNorm)), ob = new Set(b.o.map(aiNorm));
    let oc = 0; oa.forEach(x => { if (ob.has(x)) oc++; });
    const osim = oc / (oa.size + ob.size - oc || 1);
    if (jac >= 0.85 && osim >= 0.5) return true;
    const okAns = x => x.length >= 2 && !/^[0-9 ]*$/.test(x) && !GENERIC.has(x);
    if (ca && ca === cb && okAns(ca) && (DUPMODE === 'source' || jac >= 0.3)) return true;
    if (a.o.map(aiNorm).sort().join('|') === b.o.map(aiNorm).sort().join('|')) return true;
    if (okAns(ca) && okAns(cb) && (' ' + nb + ' ').includes(' ' + ca + ' ') && (' ' + na + ' ').includes(' ' + cb + ' ')) return true;
    return false;
  }
  function dedupeStrong(list) { const out = []; for (const x of list) if (!out.some(y => sameQ(x, y))) out.push(x); return out; }

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
    return { list: clean_(data.questions), note: typeof data.note === 'string' ? data.note : '' };
  }
  const clean_ = a => window.clean(a); // hàm clean() của script chính (lọc câu hỏi hợp lệ)

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
      catch (e) { lastErr = e; fails++; await sleep(1500); continue; }
      note = r.note || note;
      let added = 0;
      for (const x of r.list) { if (out.length >= n) break; if (!out.some(y => sameQ(x, y))) { out.push(x); added++; } }
      stale = added ? 0 : stale + 1;
      if (prog) prog(out.length, n);
    }
    if (!out.length) throw lastErr || Error(note || 'Không thể tạo câu hỏi. Kiểm tra tài liệu hoặc cấu hình AI.');
    sv(key, [...previous, ...out.map(x => x.q)].slice(-150));
    return out;
  }

  /* ===================================================================
   *  build(): chỉ gửi đúng phần đã chọn / đã trích xuất
   * =================================================================== */
  build = async function () {
    const all = [...(S.temp ? [S.temp] : []), ...docs()], ids = S.sel.length ? S.sel : [ld('lastDoc', '')], ds = all.filter(x => ids.includes(x.id));
    S.notice = ''; S.err = ''; S.retry = 0;
    if (!ds.length) { S.err = 'Hãy chọn ít nhất một tài liệu.'; V.mk(); return; }
    if (S.building) return;
    const mode = S.mode, exam = mode === 'exam', game = mode === 'game';
    const parts = [], labels = [];
    for (const d of ds) {
      const sc = getScope(d.id);
      if (sc.busy) { S.err = 'Đang trích xuất nội dung của “' + d.name + '”. Hãy đợi hoàn tất hoặc bấm Dừng.'; V.mk(); return; }
      const r = scopedText(d.id, d.text);
      if (r.stale) { S.err = 'Kết quả trích xuất của “' + d.name + '” đã cũ vì tài liệu đã thay đổi. Hãy bấm “Trích xuất” lại hoặc “Hủy trích xuất”.'; V.mk(); return; }
      if (r.empty) { S.err = 'Phạm vi bạn chọn trong “' + d.name + '” đang trống. Hãy chọn ít nhất một mục hoặc trích xuất lại.'; V.mk(); return; }
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

  window.__scopeTest = { analyze, parseQuick, sameQ, executePlan, scopedText, getScope, syncSel, sigOf, resolveItem };
  if (S.v === 'mk') V.mk(); else if (S.v === 'docs') V.docs();
})();

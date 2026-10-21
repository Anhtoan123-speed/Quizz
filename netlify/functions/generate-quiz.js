"use strict";

/* Netlify Function — Node.js 18+  (đặt tên netlify/functions/generate-quiz.js)
 *
 * Bản tiết kiệm token. Giao diện request/response GIỮ NGUYÊN so với bản cũ.
 * Biến môi trường (giữ nguyên): GROQ_API_KEY, GROQ_MODEL, GEMINI_API_KEY, GEMINI_MODEL, GEMINI_FALLBACK_MODEL
 * Biến tùy chọn mới:
 *   QUIZ_AUDIT = light (mặc định) | full (như bản cũ, tốn token nhất) | off (không kiểm định)
 */

const LEVELS = new Set(["Dễ", "Trung bình", "Khó", "Trộn tất cả"]);

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const reply = (statusCode, data = {}) => ({
  statusCode,
  headers: HEADERS,
  body: statusCode === 204 ? "" : JSON.stringify(data)
});

const env = key => String(process.env[key] || "").trim();
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const MAX_ATTEMPTS = 4;          // số lần gọi AI tối đa cho một request (bản cũ: 10)
const DEADLINE_MS = 48000;

function auditMode() {
  const v = env("QUIZ_AUDIT").toLowerCase();
  return ["light", "full", "off"].includes(v) ? v : "light";
}

function norm(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levelNumber(value) {
  const mapped = {
    "de": 1, "easy": 1,
    "trung binh": 2, "medium": 2,
    "kho": 3, "hard": 3
  }[norm(value)];
  if (mapped) return mapped;
  const number = Number(value);
  return [1, 2, 3].includes(number) ? number : 2;
}

function detectLanguage(text) {
  const sample = text.slice(0, 5000);
  const vietnameseMarks = (
    sample.match(/[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừữựýỳỷỹỵ]/gi) || []
  ).length;
  if (vietnameseMarks >= 3) return "vi";
  const englishWords = (
    sample.match(/\b(the|and|with|which|this|that|from|have|are)\b/gi) || []
  ).length;
  return englishWords >= 3 ? "en" : "same";
}

/* ===== PROVIDERS ===== */

function providers() {
  const result = [];

  const groqKey = env("GROQ_API_KEY");
  const groqModel = env("GROQ_MODEL");
  if (groqKey && groqModel && groqModel.toLowerCase() !== "none") {
    result.push({ type: "groq", key: groqKey, model: groqModel });
  }

  const geminiKey = env("GEMINI_API_KEY");
  if (geminiKey) {
    for (const model of [env("GEMINI_MODEL"), env("GEMINI_FALLBACK_MODEL")]) {
      if (
        model &&
        model.toLowerCase() !== "none" &&
        !result.some(item => item.type === "gemini" && item.model === model)
      ) {
        result.push({ type: "gemini", key: geminiKey, model });
      }
    }
  }
  return result;
}

/* ===== PARSE JSON (có cứu dữ liệu khi AI bị cắt giữa chừng) ===== */

const stripFence = raw => String(raw).trim()
  .replace(/^```(?:json)?\s*/i, "")
  .replace(/\s*```$/i, "");

function parseJSON(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("EMPTY_RESPONSE");
  const cleaned = stripFence(raw);
  try { return JSON.parse(cleaned); } catch { /* thử cách tiếp theo */ }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("BAD_JSON_RESPONSE");
  try { return JSON.parse(cleaned.slice(start, end + 1)); }
  catch { throw new Error("BAD_JSON_RESPONSE"); }
}

/* Khi phản hồi bị cắt do hết max tokens, vẫn lấy được các câu hỏi đã hoàn chỉnh thay vì bỏ cả đợt. */
function salvageObjects(raw, key) {
  const text = stripFence(String(raw || ""));
  const k = text.indexOf(`"${key}"`);
  let i = text.indexOf("[", k < 0 ? 0 : k);
  if (i < 0) return [];
  const out = [];
  let depth = 0, inStr = false, escaped = false, start = -1;
  for (i += 1; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* bỏ qua */ }
        start = -1;
      }
    } else if (ch === "]" && depth === 0) break;
  }
  return out;
}

function parseQuestions(raw) {
  try {
    const parsed = parseJSON(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.questions)) return parsed.questions;
  } catch { /* chuyển sang cứu dữ liệu */ }
  const saved = salvageObjects(raw, "questions");
  if (saved.length) return saved;
  throw new Error("BAD_QUIZ_STRUCTURE");
}

/* ===== NORMALIZE QUESTIONS ===== */

function normalizeQuestion(raw, mode, selectedLevel) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const question = String(raw.q ?? raw.question ?? "").trim();
  const rawOptions = raw.o ?? raw.options;
  if (!Array.isArray(rawOptions)) return null;

  const options = rawOptions.map(item => String(item ?? "").trim());

  let correct = raw.c ?? raw.correct;
  if (typeof correct === "string" && /^[A-D]$/i.test(correct.trim())) {
    correct = correct.trim().toUpperCase().charCodeAt(0) - 65;
  }
  correct = Number(correct);

  const evidence = String(raw.ev ?? raw.evidence ?? "").trim().slice(0, 300);
  let explanation = String(raw.e ?? raw.explanation ?? "").trim();
  // Giao diện yêu cầu lời giải >= 20 ký tự; lời giải ngắn được bổ sung bằng dẫn chứng.
  if (explanation.length < 20 && evidence) {
    explanation = `${explanation} Theo tài liệu: ${evidence}`.trim();
  }

  if (
    question.length < 8 ||
    options.length !== 4 ||
    options.some(option => !option) ||
    new Set(options.map(norm)).size !== 4 ||
    !Number.isInteger(correct) ||
    correct < 0 ||
    correct > 3 ||
    explanation.length < 20
  ) {
    return null;
  }

  if (/_{3,}|\bfill in the blank\b|điền vào chỗ trống|điền từ vào chỗ trống/i.test(question)) {
    return null;
  }

  return {
    q: question,
    o: options,
    c: correct,
    l: selectedLevel === "Trộn tất cả"
      ? levelNumber(raw.l ?? raw.level)
      : levelNumber(selectedLevel),
    e: explanation,
    t: String(raw.t ?? raw.topic ?? "").trim(),
    k: mode === "apply" ? "Vận dụng" : "Kiến thức",
    _ev: evidence            // chỉ dùng nội bộ, được loại bỏ trước khi trả về
  };
}

/* Dẫn chứng phải thực sự nằm trong đoạn tài liệu đã gửi (kiểm tra bằng code, không tốn token). */
function evidenceOk(evidence, srcSet, srcNorm) {
  const n = norm(evidence);
  if (!n) return false;
  if (srcNorm.includes(n)) return true;
  const tokens = n.split(" ").filter(t => t.length >= 2);
  if (tokens.length < 2) return false;
  return tokens.filter(t => srcSet.has(t)).length / tokens.length >= 0.8;
}

/* ===== DUPLICATE FILTER ===== */

const STOP_WORDS = new Set(`
la cua va cac nhung mot trong theo duoc hay nao gi
khi voi cho tu ve tren sau truoc neu thi se can phai
co khong nhat dung sai nhan dinh phat bieu lua chon
duoi day sau day phu hop chinh xac tot nhat
which what when where why how the a an of to in on
for by with and or is are does do would should
following statement correct best option choose select
most appropriate
`.trim().split(/\s+/));

const GENERIC_ANSWERS = new Set(["co", "khong", "dung", "sai", "tat ca", "khac"]);

function features(value) {
  const question = typeof value === "string" ? value : String(value?.q ?? "");

  const normalized = norm(question)
    .replace(/\bchuc nang\b/g, "vai tro")
    .replace(/\btac dung\b/g, "vai tro")
    .replace(/\bfunction of\b/g, "role of")
    .replace(/\btrong so\b/g, "trongso");

  const words = normalized
    .split(" ")
    .filter(word => word.length > 2 && !STOP_WORDS.has(word));

  const unique = new Set(words);
  const pairs = new Set(words.slice(1).map((word, index) => `${words[index]} ${word}`));

  return { normalized, unique, pairs };
}

function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const item of a) if (b.has(item)) common++;
  return common / (a.size + b.size - common);
}

function answerKey(value) {
  if (!value || !Array.isArray(value.o)) return "";
  return norm(value.o[value.c]);
}

const okAnswer = key => key.length >= 2 && !/^[0-9 ]*$/.test(key) && !GENERIC_ANSWERS.has(key);
const optionSet = value => new Set((value?.o || []).map(norm));

/* Hai câu cùng khuôn mẫu ("Từ X có nghĩa là gì?") chỉ khác từ X KHÔNG phải câu trùng.
   Bản cũ so sánh riêng phần đề nên đánh dấu nhầm hàng loạt câu từ vựng, khiến server phải gọi AI lại nhiều lần.
   Bản này chỉ coi là trùng khi: cùng đề, cùng đáp án đúng, cùng bộ lựa chọn, hỏi ngược, hoặc đề gần như y hệt kèm lựa chọn chồng lấn. */
function isRepeated(first, second, strict = true) {
  const a = features(first);
  const b = features(second);

  if (!a.normalized || !b.normalized) return false;
  if (a.normalized === b.normalized) return true;

  const lexical = similarity(a.unique, b.unique);
  const ka = answerKey(first);
  const kb = answerKey(second);

  if (ka && kb) {
    if (ka === kb && okAnswer(ka) && (strict || lexical >= 0.3)) return true;

    const oa = optionSet(first), ob = optionSet(second);
    if (similarity(oa, ob) >= 0.75) return true;

    // Hỏi ngược: đề này chứa đáp án của câu kia và ngược lại.
    if (
      okAnswer(ka) && okAnswer(kb) &&
      ` ${b.normalized} `.includes(` ${ka} `) &&
      ` ${a.normalized} `.includes(` ${kb} `)
    ) return true;

    return a.unique.size >= 4 && b.unique.size >= 4 &&
      lexical >= 0.85 && similarity(oa, ob) >= 0.5;
  }

  // Một bên chỉ có nội dung câu hỏi (danh sách loại trừ do giao diện gửi): chỉ loại khi gần như y hệt.
  const phrase = similarity(a.pairs, b.pairs);
  return a.unique.size >= 4 && b.unique.size >= 4 &&
    (lexical >= 0.92 || (lexical >= 0.85 && phrase >= 0.8));
}

function isDuplicate(question, existing, strict = true) {
  return existing.some(item => isRepeated(question, item, strict));
}

/* ===== PROMPTS (rút gọn) ===== */

function generationPrompt({ text, subject, mode, level, language, count, existing }) {
  const levelLine = level === "Trộn tất cả"
    ? "Trộn dễ/trung bình/khó (l=1/2/3)."
    : `Mức ${level} (l=${levelNumber(level)}).`;

  const modeLine = mode === "apply"
    ? "Mỗi câu là tình huống/bài tập vận dụng kiến thức trong tài liệu; không thêm dữ kiện ngoài tài liệu. ev = trích nguyên văn ≤15 từ của kiến thức được áp dụng."
    : "Mỗi câu phải trả lời được trực tiếp từ tài liệu, không dùng kiến thức ngoài. ev = trích NGUYÊN VĂN ≤15 từ từ tài liệu làm căn cứ.";

  const lang = language === "vi" ? "tiếng Việt" : language === "en" ? "tiếng Anh" : "cùng ngôn ngữ tài liệu";

  const avoid = existing.slice(-16).map(item => String(item).slice(0, 60));

  return `
Tạo ${count} câu trắc nghiệm từ TÀI LIỆU. Chỉ trả JSON:
{"questions":[{"q":"","o":["","","",""],"c":0,"l":2,"e":"","ev":"","t":""}]}
- 4 lựa chọn khác nhau, đúng 1 đáp án; c = chỉ số (từ 0) của đáp án đúng.
- e: 1-2 câu giải thích vì sao đáp án c đúng. t: chủ đề ≤3 từ.
- ${modeLine}
- ${levelLine} Ngôn ngữ: ${lang}. Chủ đề: ${subject || "nội dung tài liệu"}.
- Mỗi câu hỏi một ý khác nhau, đáp án đúng khác nhau; không hỏi ngược hay đổi cách diễn đạt; không điền chỗ trống. Không đủ căn cứ thì bỏ câu đó.${avoid.length ? `\nKhông lặp các câu: ${JSON.stringify(avoid)}` : ""}

TÀI LIỆU:
${text}
`.trim();
}

/* ===== GỌI MODEL ===== */

async function request(url, headers, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const raw = await response.text();

    if (!response.ok) {
      const error = new Error("UPSTREAM_HTTP");
      error.status = response.status;
      try {
        const parsed = JSON.parse(raw);
        error.code = String(parsed?.error?.code || parsed?.error?.type || "").slice(0, 50);
      } catch { /* thân lỗi không phải JSON */ }
      throw error;
    }

    try { return JSON.parse(raw); } catch { throw new Error("INVALID_UPSTREAM_JSON"); }
  } finally {
    clearTimeout(timer);
  }
}

/* Trả về văn bản thô của model. `usage.tokens` cộng dồn tổng token đã dùng (để theo dõi chi phí). */
async function callModel(provider, promptText, maxTokens, timeoutMs, usage) {
  if (provider.type === "groq") {
    const url = "https://api.groq.com/openai/v1/chat/completions";
    // Model có "suy nghĩ" (gpt-oss, qwen3) sẽ tốn thêm token; giảm xuống mức thấp nhất nếu model hỗ trợ.
    const reasoning = /gpt-oss/i.test(provider.model) ? "low" : /qwen3/i.test(provider.model) ? "none" : null;
    const variants = [];
    if (reasoning) variants.push({ json: true, reason: true });
    variants.push({ json: true, reason: false }, { json: false, reason: false });

    let data;
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const payload = {
        model: provider.model,
        messages: [
          { role: "system", content: "Return only valid JSON. Follow the requested JSON structure exactly." },
          { role: "user", content: promptText }
        ],
        temperature: 0.2,
        max_completion_tokens: maxTokens
      };
      if (v.json) payload.response_format = { type: "json_object" };
      if (v.reason) payload.reasoning_effort = reasoning;
      try {
        data = await request(url, { Authorization: `Bearer ${provider.key}` }, payload, i === 0 ? timeoutMs : Math.min(timeoutMs, 12000));
        break;
      } catch (error) {
        // 400 = model không hỗ trợ tham số này: thử cấu hình đơn giản hơn.
        if (error.status !== 400 || i === variants.length - 1) throw error;
      }
    }
    usage.tokens += Number(data?.usage?.total_tokens) || 0;
    return data?.choices?.[0]?.message?.content;
  }

  const model = provider.model.replace(/^models\//, "");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const base = { contents: [{ role: "user", parts: [{ text: promptText }] }] };
  const jsonConfig = () => ({ responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: maxTokens });

  // Gemini 2.5 Flash tính phí cả token "suy nghĩ": tắt bằng thinkingBudget = 0.
  const variants = [];
  if (/2\.5-flash/i.test(model)) {
    variants.push({ ...base, generationConfig: { ...jsonConfig(), thinkingConfig: { thinkingBudget: 0 } } });
  }
  variants.push({ ...base, generationConfig: jsonConfig() }, base);

  let data;
  for (let i = 0; i < variants.length; i++) {
    try {
      data = await request(url, { "x-goog-api-key": provider.key }, variants[i], i === 0 ? timeoutMs : Math.min(timeoutMs, 12000));
      break;
    } catch (error) {
      if (error.status !== 400 || i === variants.length - 1) throw error;
    }
  }
  usage.tokens += Number(data?.usageMetadata?.totalTokenCount) || 0;

  return (data?.candidates?.[0]?.content?.parts || [])
    .filter(part => !part.thought)
    .map(part => part.text || "")
    .join("");
}

/* ===== KIỂM ĐỊNH ===== */

/* Kiểm định nhẹ: KHÔNG gửi lại tài liệu. Chỉ gửi đề + 4 lựa chọn + dẫn chứng; AI chỉ trả số đáp án.
   Chỉ loại câu khi AI khẳng định một đáp án KHÁC với đáp án đã tạo (tránh c và lời giải lệch nhau). */
async function lightAudit(provider, questions, timeoutMs, usage) {
  const items = questions.map((x, i) => ({ i, q: x.q, o: x.o, ev: x._ev || "" }));
  const prompt =
    "Với mỗi câu, chọn đáp án đúng CHỈ dựa vào dẫn chứng ev. Nếu ev không đủ để chắc chắn thì c=-1.\n" +
    'Chỉ trả JSON: {"a":[{"i":0,"c":1}]}\n' + JSON.stringify(items);

  const raw = await callModel(provider, prompt, clamp(items.length * 14 + 120, 250, 1500), timeoutMs, usage);
  const parsed = parseJSON(raw);
  const list = Array.isArray(parsed) ? parsed : (parsed?.a || parsed?.answers || []);
  const byIndex = new Map(list.map(item => [Number(item?.i), Number(item?.c)]));

  return questions.filter((question, i) => {
    const verdict = byIndex.get(i);
    return !(Number.isInteger(verdict) && verdict >= 0 && verdict <= 3 && verdict !== question.c);
  });
}

/* Kiểm định đầy đủ (như bản cũ): gửi lại tài liệu + viết lại lời giải. Chỉ dùng khi QUIZ_AUDIT=full
   hoặc khi AI không chịu trả dẫn chứng (ev). */
async function fullAudit(provider, sourceText, questions, timeoutMs, usage) {
  if (!questions.length) return [];

  const auditPrompt = `
Bạn là người kiểm định câu hỏi trắc nghiệm. Chỉ dùng tài liệu nguồn dưới đây.

Với từng câu:
- Tự xác định lựa chọn đúng từ tài liệu, không tin mặc định đáp án c hiện tại.
- Nếu đáp án c hiện tại sai nhưng tài liệu xác định được đáp án đúng duy nhất, hãy sửa c.
- Viết lại e để giải thích vì sao lựa chọn ở vị trí c đúng, dựa trên tài liệu.
- Nếu tài liệu không đủ căn cứ, câu hỏi mơ hồ, có nhiều đáp án đúng hoặc không có đáp án đúng, đặt valid=false.
- Không thêm thông tin ngoài tài liệu.
- Trả lại đủ một mục cho mỗi id.

Chỉ trả JSON theo cấu trúc:
{"questions":[{"id":0,"valid":true,"c":0,"e":"Lời giải đã kiểm tra"}]}

TÀI LIỆU NGUỒN:
${sourceText}

CÁC CÂU CẦN KIỂM ĐỊNH:
${JSON.stringify(questions.map((question, id) => ({ id, q: question.q, o: question.o, c: question.c, e: question.e })))}
`.trim();

  const raw = await callModel(provider, auditPrompt, clamp(questions.length * 140 + 200, 500, 6000), timeoutMs, usage);
  const audited = parseQuestions(raw);
  const resultById = new Map(audited.map(item => [Number(item.id), item]));

  return questions.flatMap((question, id) => {
    const result = resultById.get(id);
    const correct = Number(result?.c);
    const explanation = String(result?.e ?? "").trim();

    if (
      result?.valid !== true ||
      !Number.isInteger(correct) || correct < 0 || correct > 3 ||
      explanation.length < 20
    ) return [];

    return [{ ...question, c: correct, e: explanation }];
  });
}

/* ===== ERROR CATEGORIES ===== */

function errorCategory(error) {
  if (error.name === "AbortError") return "TIMEOUT";
  if (error.status === 429) return "RATE_LIMIT";
  if (error.status === 401 || error.status === 403) return "AUTH";
  if (error.status === 404) return "MODEL_NOT_FOUND";
  if (error.status === 400) return "BAD_PROVIDER_REQUEST";
  if (error.status >= 500) return "PROVIDER_UNAVAILABLE";
  return error.message || "NETWORK_ERROR";
}

/* ===== NETLIFY HANDLER ===== */

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") return reply(204);
  if (event.httpMethod !== "POST") return reply(405, { error: "Chỉ hỗ trợ POST." });

  let input;
  try { input = JSON.parse(event.body || "{}"); }
  catch { return reply(400, { error: "Dữ liệu JSON không hợp lệ." }); }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return reply(400, { error: "Dữ liệu không hợp lệ." });
  }

  const text = typeof input.text === "string" ? input.text.trim().slice(0, 24000) : "";
  const subject = typeof input.subject === "string" ? input.subject.trim().slice(0, 200) : "";
  const level = LEVELS.has(input.level) ? input.level : null;
  const mode = input.quizMode === "apply" ? "apply" : "source";
  const strict = mode === "source";

  const requestedCount = Number.isFinite(Number(input.count)) ? Math.floor(Number(input.count)) : 10;
  const count = clamp(requestedCount, 1, 50);
  const baseBatch = clamp(Math.floor(Number(input.batch)) || 0, 0, 1000);

  const exclude = Array.isArray(input.exclude)
    ? input.exclude.filter(item => typeof item === "string").slice(-100).map(item => ({ q: item }))
    : [];

  if (text.length < 100) return reply(400, { error: "Tài liệu phải có ít nhất 100 ký tự." });
  if (!level) return reply(400, { error: "Mức độ câu hỏi không hợp lệ." });

  const availableProviders = providers();
  if (!availableProviders.length) {
    return reply(500, {
      error:
        "Thiếu API key/model. Hãy thiết lập GROQ_API_KEY và GROQ_MODEL " +
        "hoặc GEMINI_API_KEY và GEMINI_MODEL."
    });
  }

  const audit = auditMode();
  const language = detectLanguage(text);
  const startTime = Date.now();
  const deadline = startTime + DEADLINE_MS;
  const usage = { tokens: 0 };

  /* Tài liệu ngắn chỉ đủ cho một số câu nhất định (~1 câu / 30 ký tự). Nếu giao diện đã có đủ số câu đó
     thì trả về ngay, không gọi AI để rồi nhận toàn câu trùng. */
  const capTotal = Math.max(5, Math.floor(text.length / 30));
  if (capTotal <= 100 && exclude.length >= capTotal) {
    return reply(200, {
      questions: [],
      meta: { requested: count, generated: 0, exhausted: true, cap: capTotal, tokens: 0, quizMode: mode },
      note: "Tài liệu/phạm vi đã chọn không còn đủ nội dung mới để tạo thêm câu hỏi."
    });
  }
  const target = Math.min(count, capTotal);

  const found = [];
  const errors = [];
  const disabledProviders = new Set();

  let duplicateCount = 0;
  let invalidCount = 0;
  let ungroundedCount = 0;
  let attempts = 0;
  let cycle = 0;

  while (found.length < target && attempts < MAX_ATTEMPTS && Date.now() < deadline - 5000) {
    let madeProgress = false;

    for (const provider of availableProviders) {
      const providerId = `${provider.type}:${provider.model}`;

      if (
        disabledProviders.has(providerId) ||
        found.length >= target ||
        attempts >= MAX_ATTEMPTS ||
        Date.now() >= deadline - 5000
      ) continue;

      const remaining = target - found.length;
      // Chỉ dư vài câu để bù câu bị lọc trùng (bản cũ dư tới 25%, phần dư bị bỏ phí).
      const batchSize = clamp(
        remaining + (remaining >= 8 ? 2 : 1),
        1,
        provider.type === "groq" ? 10 : 14
      );

      // Đoạn tài liệu gửi đi tỉ lệ với số câu cần tạo (bản cũ luôn gửi 5200 / 10000 ký tự).
      const chunkSize = provider.type === "groq"
        ? clamp(batchSize * 450, 2600, 5200)
        : clamp(batchSize * 700, 3500, 10000);

      let source = text;
      if (text.length > chunkSize) {
        const span = Math.max(1, text.length - chunkSize + 1);
        const step = Math.floor(chunkSize * 0.7);
        const start = ((baseBatch + cycle++) * step) % span;
        source = text.slice(start, start + chunkSize);
      }

      const promptText = generationPrompt({
        text: source,
        subject,
        mode,
        level,
        language,
        count: batchSize,
        existing: [...exclude.map(item => item.q), ...found.map(item => item.q)]
      });

      const generationTimeout = Math.min(16000, deadline - Date.now() - 3500);
      if (generationTimeout < 2500) break;

      attempts++;

      try {
        const raw = await callModel(
          provider,
          promptText,
          clamp(batchSize * 300 + 300, 800, provider.type === "groq" ? 7500 : 8192),
          generationTimeout,
          usage
        );
        const incoming = parseQuestions(raw);

        const srcNorm = norm(source);
        const srcSet = new Set(srcNorm.split(" "));
        const candidates = [];
        const lacking = [];

        for (const item of incoming) {
          const question = normalizeQuestion(item, mode, level);
          if (!question) { invalidCount++; continue; }

          if (
            isDuplicate(question, [...found, ...candidates, ...lacking], strict) ||
            isDuplicate(question, exclude, strict)
          ) { duplicateCount++; continue; }

          if (mode === "source") {
            if (!question._ev) { lacking.push(question); continue; }
            if (!evidenceOk(question._ev, srcSet, srcNorm)) { ungroundedCount++; continue; }
          }
          candidates.push(question);
          if (candidates.length >= remaining) break;
        }

        // AI không chịu trả dẫn chứng: kiểm định đầy đủ để giữ chất lượng.
        let pool = candidates;
        let needFull = audit === "full";
        if (!pool.length && lacking.length && audit !== "off") {
          pool = lacking.slice(0, remaining);
          needFull = true;
        } else if (!pool.length && lacking.length) {
          pool = lacking.slice(0, remaining);
        }

        if (!pool.length) {
          errors.push({ provider: provider.type, model: provider.model, category: "NO_VALID_QUESTIONS" });
          continue;
        }

        let approved = pool;
        const auditTimeout = Math.min(10000, deadline - Date.now() - 1500);

        if (audit !== "off") {
          if (needFull) {
            if (auditTimeout < 2000) {
              errors.push({ provider: provider.type, model: provider.model, category: "NOT_ENOUGH_TIME_TO_AUDIT" });
              continue;
            }
            approved = await fullAudit(provider, source, pool, auditTimeout, usage);
          } else if (auditTimeout >= 2000) {
            try {
              approved = await lightAudit(provider, pool, Math.min(auditTimeout, 8000), usage);
            } catch (error) {
              // Kiểm định nhẹ lỗi: câu hỏi đã qua kiểm tra dẫn chứng nên vẫn dùng được, tránh phí token đã tạo.
              errors.push({ provider: provider.type, model: provider.model, category: "AUDIT_SKIPPED", status: error.status || null });
              approved = pool;
            }
          }
        }

        // Lọc tuần tự: giữ câu đầu, bỏ câu sau nếu trùng (đáp án có thể đã đổi sau kiểm định).
        const fresh = [];
        for (const question of approved) {
          if (isDuplicate(question, [...found, ...fresh], strict)) { duplicateCount++; continue; }
          fresh.push(question);
        }

        if (fresh.length) {
          found.push(...fresh.slice(0, remaining));
          madeProgress = true;
          break;
        }

        errors.push({ provider: provider.type, model: provider.model, category: "AUDIT_REJECTED_QUESTIONS" });
      } catch (error) {
        const category = errorCategory(error);
        errors.push({ provider: provider.type, model: provider.model, category, status: error.status || null });
        console.warn("Quiz provider error", { provider: provider.type, model: provider.model, category, status: error.status || null });
        if ([400, 401, 403, 404, 413].includes(error.status)) disabledProviders.add(providerId);
      }
    }

    if (!madeProgress && disabledProviders.size >= availableProviders.length) break;
  }

  console.info("quiz-usage", { requested: count, generated: found.length, attempts, tokens: usage.tokens, audit, mode });

  if (!found.length) {
    return reply(502, {
      error:
        "Không tạo được câu hỏi đã qua kiểm định. " +
        "Kiểm tra API key, model, hạn mức hoặc thử tài liệu khác.",
      details: errors.slice(-5),
      meta: { requested: count, generated: 0, attempts, quizMode: mode, tokens: usage.tokens }
    });
  }

  const questions = found.slice(0, count).map(({ _ev, ...rest }) => rest);
  const easy = questions.filter(question => question.l === 1).length;
  const medium = questions.filter(question => question.l === 2).length;
  const hard = questions.filter(question => question.l === 3).length;
  const applications = questions.filter(question => question.k === "Vận dụng").length;

  let note = "";
  if (questions.length < count) {
    note = `Tạo được ${questions.length}/${count} câu đã qua kiểm định. ` +
      (target < count
        ? `Tài liệu khá ngắn nên chỉ đủ khoảng ${capTotal} câu.`
        : "Tài liệu có thể chưa đủ nội dung hoặc câu hỏi còn lại không xác định được đáp án chắc chắn.");
  }

  return reply(200, {
    questions,
    meta: {
      requested: count,
      generated: questions.length,
      easy,
      medium,
      hard,
      knowledgeQuestions: questions.length - applications,
      applicationQuestions: applications,
      sourceLanguage: language,
      quizMode: mode,
      audit,
      duplicatesFiltered: duplicateCount,
      invalidFiltered: invalidCount,
      ungroundedFiltered: ungroundedCount,
      attempts,
      tokens: usage.tokens,
      elapsedMs: Date.now() - startTime
    },
    note
  });
};

/* ===== TEST HELPERS ===== */

if (process.env.NODE_ENV === "test") {
  exports._test = { normalizeQuestion, isRepeated, isDuplicate, features, detectLanguage, parseQuestions, salvageObjects, evidenceOk };
}

"use strict";

/* Netlify Function — Node.js 18+ */

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
    "de": 1,
    "easy": 1,
    "trung binh": 2,
    "medium": 2,
    "kho": 3,
    "hard": 3
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
    result.push({
      type: "groq",
      key: groqKey,
      model: groqModel
    });
  }

  const geminiKey = env("GEMINI_API_KEY");

  if (geminiKey) {
    const geminiModels = [
      env("GEMINI_MODEL"),
      env("GEMINI_FALLBACK_MODEL")
    ];

    for (const model of geminiModels) {
      if (
        model &&
        model.toLowerCase() !== "none" &&
        !result.some(item => item.type === "gemini" && item.model === model)
      ) {
        result.push({
          type: "gemini",
          key: geminiKey,
          model
        });
      }
    }
  }

  return result;
}

/* ===== PARSE AI OUTPUT ===== */

function parseResponse(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("EMPTY_RESPONSE");
  }

  const cleaned = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  let parsed;

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start < 0 || end <= start) {
      throw new Error("BAD_JSON_RESPONSE");
    }

    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      throw new Error("BAD_JSON_RESPONSE");
    }
  }

  if (Array.isArray(parsed)) return parsed;

  if (!Array.isArray(parsed?.questions)) {
    throw new Error("BAD_QUIZ_STRUCTURE");
  }

  return parsed.questions;
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

  const explanation = String(raw.e ?? raw.explanation ?? "").trim();

  if (
    question.length < 8 ||
    options.length !== 4 ||
    options.some(option => !option) ||
    new Set(options.map(norm)).size !== 4 ||
    !Number.isInteger(correct) ||
    correct < 0 ||
    correct > 3 ||
    explanation.length < 10
  ) {
    return null;
  }

  if (
    /_{3,}|\bfill in the blank\b|điền vào chỗ trống|điền từ vào chỗ trống/i.test(question)
  ) {
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
    k: mode === "apply" ? "Vận dụng" : "Kiến thức"
  };
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

function features(value) {
  const question = typeof value === "string"
    ? value
    : String(value?.q ?? "");

  const normalized = norm(question)
    .replace(/\bchuc nang\b/g, "vai tro")
    .replace(/\btac dung\b/g, "vai tro")
    .replace(/\bfunction of\b/g, "role of")
    .replace(/\btrong so\b/g, "trongso");

  const words = normalized
    .split(" ")
    .filter(word => word.length > 2 && !STOP_WORDS.has(word));

  const unique = new Set(words);
  const pairs = new Set(
    words.slice(1).map((word, index) => `${words[index]} ${word}`)
  );

  return {
    normalized,
    unique,
    pairs,
    topic: norm(value?.t ?? "")
  };
}

function similarity(a, b) {
  if (!a.size || !b.size) return 0;

  let common = 0;
  for (const item of a) {
    if (b.has(item)) common++;
  }

  return common / (a.size + b.size - common);
}

function isRepeated(first, second) {
  const a = features(first);
  const b = features(second);

  if (!a.normalized || !b.normalized) return false;
  if (a.normalized === b.normalized) return true;

  const lexical = similarity(a.unique, b.unique);
  const phrase = similarity(a.pairs, b.pairs);

  if (a.topic && b.topic && a.topic !== b.topic && lexical < 0.9) {
    return false;
  }

  return (
    a.unique.size >= 4 &&
    b.unique.size >= 4 &&
    (lexical >= 0.87 || (lexical >= 0.71 && phrase >= 0.58))
  );
}

function isDuplicate(question, existing) {
  return existing.some(item => isRepeated(question, item));
}

/* ===== PROMPTS ===== */

function generationPrompt({
  text,
  subject,
  mode,
  level,
  language,
  count,
  existing
}) {
  const levelInstruction = level === "Trộn tất cả"
    ? "Trộn câu dễ, trung bình, khó tương đối đều; l lần lượt là 1, 2, 3."
    : `Tất cả câu hỏi ở mức level;l={levelNumber(level)}.`;

  const modeInstruction = mode === "apply"
    ? "Tất cả câu hỏi phải yêu cầu vận dụng, giải quyết tình huống hoặc bài tập dựa trên tài liệu. Không tự tạo dữ kiện ngoài tài liệu."
    : "Tất cả câu hỏi phải được trả lời trực tiếp từ nội dung tài liệu. Không dùng kiến thức ngoài tài liệu.";

  return `
Tạo đúng ${count} câu hỏi trắc nghiệm độc lập, đa dạng.

Chỉ trả về một JSON hợp lệ theo cấu trúc:
{"questions":[{"q":"Câu hỏi","o":["A","B","C","D"],"c":0,"l":2,"e":"Lời giải","t":"Chủ đề"}]}

Quy tắc:
- Ngôn ngữ của q, o, e, t: ${
    language === "vi" ? "tiếng Việt" :
    language === "en" ? "tiếng Anh" :
    "cùng ngôn ngữ với tài liệu"
  }.
- Có đúng 4 lựa chọn khác nhau và chỉ có một đáp án đúng.
- c là chỉ số bắt đầu từ 0 của đáp án đúng trong mảng o.
- e phải giải thích vì sao chính lựa chọn ở vị trí c là đúng, dựa trên tài liệu.
- Trước khi trả lời, tự kiểm tra c và e có cùng nói về một lựa chọn hay không.
- Nếu tài liệu không đủ căn cứ xác định một đáp án duy nhất, bỏ câu hỏi đó.
- Không tạo câu điền vào chỗ trống.
- Mỗi câu kiểm tra một mục tiêu học tập khác nhau; không diễn đạt lại câu khác.
- Không lặp tình huống chỉ bằng cách đổi tên nhân vật.
- ${modeInstruction}
- ${levelInstruction}
- Chủ đề: ${subject || "nội dung tài liệu"}.

Không lặp lại hoặc diễn đạt lại các câu sau:
${JSON.stringify(existing.slice(-30).map(item => String(item).slice(0, 180)))}

TÀI LIỆU NGUỒN:
${text}
`.trim();
}

/* ===== PROVIDER REQUEST ===== */

async function request(url, headers, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const raw = await response.text();

    if (!response.ok) {
      const error = new Error("UPSTREAM_HTTP");
      error.status = response.status;

      try {
        const parsed = JSON.parse(raw);
        error.code = String(
          parsed?.error?.code || parsed?.error?.type || ""
        ).slice(0, 50);
      } catch {
        // Bỏ qua phần thân lỗi không phải JSON.
      }

      throw error;
    }

    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("INVALID_UPSTREAM_JSON");
    }
  } finally {
    clearTimeout(timer);
  }
}

async function generate(provider, promptText, batchSize, timeoutMs) {
  if (provider.type === "groq") {
    const payload = {
      model: provider.model,
      messages: [
        {
          role: "system",
          content: "Return only valid JSON. Follow the requested JSON structure exactly."
        },
        {
          role: "user",
          content: promptText
        }
      ],
      temperature: 0.2,
      max_completion_tokens: clamp(batchSize * 450, 1200, 7500),
      response_format: { type: "json_object" }
    };

    let data;

    try {
      data = await request(
        "https://api.groq.com/openai/v1/chat/completions",
        { Authorization: `Bearer ${provider.key}` },
        payload,
        timeoutMs
      );
    } catch (error) {
      // Một số model Groq không hỗ trợ response_format.
      if (error.status !== 400) throw error;

      delete payload.response_format;

      data = await request(
        "https://api.groq.com/openai/v1/chat/completions",
        { Authorization: `Bearer ${provider.key}` },
        payload,
        Math.min(timeoutMs, 12000)
      );
    }

    return parseResponse(data?.choices?.[0]?.message?.content);
  }

  const model = provider.model.replace(/^models\//, "");
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(model)}:generateContent`;

  const basePayload = {
    contents: [{
      role: "user",
      parts: [{ text: promptText }]
    }]
  };

  const jsonPayload = {
    ...basePayload,
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
      maxOutputTokens: clamp(batchSize * 450, 1200, 8192)
    }
  };

  let data;

  try {
    data = await request(
      url,
      { "x-goog-api-key": provider.key },
      jsonPayload,
      timeoutMs
    );
  } catch (error) {
    // Thử lại nếu model Gemini không nhận cấu hình JSON.
    if (error.status !== 400) throw error;

    data = await request(
      url,
      { "x-goog-api-key": provider.key },
      basePayload,
      Math.min(timeoutMs, 12000)
    );
  }

  const text = (data?.candidates?.[0]?.content?.parts || [])
    .filter(part => !part.thought)
    .map(part => part.text || "")
    .join("");

  return parseResponse(text);
}

/* ===== ANSWER AND EXPLANATION AUDIT ===== */

async function auditQuestions(provider, sourceText, questions, timeoutMs) {
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
${JSON.stringify(questions.map((question, id) => ({
    id,
    q: question.q,
    o: question.o,
    c: question.c,
    e: question.e
  })))}
`.trim();

  const audited = await generate(
    provider,
    auditPrompt,
    questions.length,
    timeoutMs
  );

  const resultById = new Map(
    audited.map(item => [Number(item.id), item])
  );

  return questions.flatMap((question, id) => {
    const result = resultById.get(id);
    const correct = Number(result?.c);
    const explanation = String(result?.e ?? "").trim();

    if (
      result?.valid !== true ||
      !Number.isInteger(correct) ||
      correct < 0 ||
      correct > 3 ||
      explanation.length < 10
    ) {
      return [];
    }

    return [{
      ...question,
      c: correct,
      e: explanation
    }];
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
  if (event.httpMethod === "OPTIONS") {
    return reply(204);
  }

  if (event.httpMethod !== "POST") {
    return reply(405, { error: "Chỉ hỗ trợ POST." });
  }

  let input;

  try {
    input = JSON.parse(event.body || "{}");
  } catch {
    return reply(400, { error: "Dữ liệu JSON không hợp lệ." });
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return reply(400, { error: "Dữ liệu không hợp lệ." });
  }

  const text = typeof input.text === "string"
    ? input.text.trim().slice(0, 24000)
    : "";

  const subject = typeof input.subject === "string"
    ? input.subject.trim().slice(0, 200)
    : "";

  const level = LEVELS.has(input.level) ? input.level : null;
  const mode = input.quizMode === "apply" ? "apply" : "source";

  const requestedCount = Number.isFinite(Number(input.count))
    ? Math.floor(Number(input.count))
    : 10;

  const count = clamp(requestedCount, 1, 50);

  const exclude = Array.isArray(input.exclude)
    ? input.exclude
        .filter(item => typeof item === "string")
        .slice(-100)
        .map(item => ({ q: item }))
    : [];

  if (text.length < 100) {
    return reply(400, {
      error: "Tài liệu phải có ít nhất 100 ký tự."
    });
  }

  if (!level) {
    return reply(400, {
      error: "Mức độ câu hỏi không hợp lệ."
    });
  }

  const availableProviders = providers();

  if (!availableProviders.length) {
    return reply(500, {
      error:
        "Thiếu API key/model. Hãy thiết lập GROQ_API_KEY và GROQ_MODEL " +
        "hoặc GEMINI_API_KEY và GEMINI_MODEL."
    });
  }

  const language = detectLanguage(text);
  const startTime = Date.now();
  const deadline = startTime + 48000;

  const found = [];
  const errors = [];
  const disabledProviders = new Set();

  let duplicateCount = 0;
  let invalidCount = 0;
  let attempts = 0;
  let cycle = 0;
  const maxAttempts = 10;

  while (
    found.length < count &&
    attempts < maxAttempts &&
    Date.now() < deadline - 5000
  ) {
    let madeProgress = false;

    for (const provider of availableProviders) {
      const providerId = `provider.type:{provider.model}`;

      if (
        disabledProviders.has(providerId) ||
        found.length >= count ||
        attempts >= maxAttempts ||
        Date.now() >= deadline - 5000
      ) {
        continue;
      }

      const remaining = count - found.length;
      const batchSize = clamp(
        remaining + Math.max(2, Math.ceil(remaining * 0.25)),
        1,
        provider.type === "groq" ? 10 : 14
      );

      const chunkSize = provider.type === "groq" ? 5200 : 10000;
      const source = text.length <= chunkSize
        ? text
        : text.slice(
            (cycle++ * Math.floor(chunkSize * 0.7)) %
              Math.max(1, text.length - chunkSize + 1),
            ((cycle - 1) * Math.floor(chunkSize * 0.7)) %
              Math.max(1, text.length - chunkSize + 1) + chunkSize
          );

      const knownQuestions = [
        ...exclude,
        ...found.map(question => ({ q: question.q }))
      ];

      const promptText = generationPrompt({
        text: source,
        subject,
        mode,
        level,
        language,
        count: batchSize,
        existing: knownQuestions
      });

      const remainingMs = deadline - Date.now();
      const generationTimeout = Math.min(16000, remainingMs - 3500);

      if (generationTimeout < 2500) break;

      attempts++;

      try {
        const incoming = await generate(
          provider,
          promptText,
          batchSize,
          generationTimeout
        );

        const candidates = [];

        for (const raw of incoming) {
          const question = normalizeQuestion(raw, mode, level);

          if (!question) {
            invalidCount++;
            continue;
          }

          if (isDuplicate(question, [...found, ...candidates])) {
            duplicateCount++;
            continue;
          }

          if (isDuplicate(question, exclude)) {
            duplicateCount++;
            continue;
          }

          candidates.push(question);

          if (candidates.length >= remaining) break;
        }

        if (!candidates.length) {
          errors.push({
            provider: provider.type,
            model: provider.model,
            category: "NO_VALID_QUESTIONS"
          });
          continue;
        }

        const auditTimeout = Math.min(
          10000,
          deadline - Date.now() - 1500
        );

        if (auditTimeout < 2000) {
          errors.push({
            provider: provider.type,
            model: provider.model,
            category: "NOT_ENOUGH_TIME_TO_AUDIT"
          });
          continue;
        }

        const approved = await auditQuestions(
          provider,
          source,
          candidates,
          auditTimeout
        );

        const fresh = approved.filter(question =>
          !isDuplicate(question, [...found, ...approved.filter(item => item !== question)])
        );

        if (fresh.length) {
          found.push(...fresh.slice(0, remaining));
          madeProgress = true;
          break;
        }

        errors.push({
          provider: provider.type,
          model: provider.model,
          category: "AUDIT_REJECTED_QUESTIONS"
        });
      } catch (error) {
        const category = errorCategory(error);

        errors.push({
          provider: provider.type,
          model: provider.model,
          category,
          status: error.status || null
        });

        console.warn("Quiz provider error", {
          provider: provider.type,
          model: provider.model,
          category,
          status: error.status || null
        });

        if ([400, 401, 403, 404, 413].includes(error.status)) {
          disabledProviders.add(providerId);
        }
      }
    }

    if (!madeProgress && disabledProviders.size >= availableProviders.length) {
      break;
    }
  }

  if (!found.length) {
    return reply(502, {
      error:
        "Không tạo được câu hỏi đã qua kiểm định. " +
        "Kiểm tra API key, model, hạn mức hoặc thử tài liệu khác.",
      details: errors.slice(-5),
      meta: {
        requested: count,
        generated: 0,
        attempts,
        quizMode: mode
      }
    });
  }

  const questions = found.slice(0, count);
  const easy = questions.filter(question => question.l === 1).length;
  const medium = questions.filter(question => question.l === 2).length;
  const hard = questions.filter(question => question.l === 3).length;
  const applications = questions.filter(
    question => question.k === "Vận dụng"
  ).length;

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
      duplicatesFiltered: duplicateCount,
      invalidFiltered: invalidCount,
      attempts,
      elapsedMs: Date.now() - startTime
    },
    note: questions.length < count
      ? `Tạo được questions.length/{count} câu đã qua kiểm định. ` +
        "Tài liệu có thể chưa đủ nội dung hoặc câu hỏi còn lại không xác định được đáp án chắc chắn."
      : ""
  });
};

/* ===== TEST HELPERS ===== */

if (process.env.NODE_ENV === "test") {
  exports._test = {
    normalizeQuestion,
    isRepeated,
    isDuplicate,
    features,
    detectLanguage
  };
}


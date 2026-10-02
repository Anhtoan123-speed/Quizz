/*
 * netlify/functions/generate-quiz.js
 *
 * Các biến môi trường:
 * GEMINI_API_KEY
 * GEMINI_MODEL
 * GEMINI_FALLBACK_MODEL
 * GEMINI_FALLBACK_THINKING
 * GROQ_API_KEY
 * GROQ_MODEL
 *
 * Thứ tự: Gemini chính → Gemini dự phòng → Groq.
 * Đặt GEMINI_FALLBACK_MODEL=none để tắt Gemini dự phòng.
 */

const LEVELS = new Set([
  "Dễ",
  "Trung bình",
  "Khó",
  "Trộn tất cả"
]);

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function reply(statusCode, data) {
  return {
    statusCode,
    headers: HEADERS,
    body: statusCode === 204 ? "" : JSON.stringify(data)
  };
}

function env(name) {
  return (process.env[name] || "").trim();
}

function normalize(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSimilar(a, b) {
  const first = normalize(a);
  const second = normalize(b);

  if (!first || !second) return false;
  if (first === second) return true;

  const wordsA = new Set(first.split(" "));
  const wordsB = new Set(second.split(" "));

  const common = [...wordsA].filter(
    word => wordsB.has(word)
  ).length;

  const union = wordsA.size + wordsB.size - common;
  return union > 0 && common / union >= 0.82;
}

function validQuestion(q) {
  return (
    q &&
    typeof q.q === "string" &&
    q.q.trim().length >= 8 &&
    !/điền từ|chỗ trống|_{3,}/i.test(q.q) &&
    Array.isArray(q.o) &&
    q.o.length === 4 &&
    q.o.every(
      option => typeof option === "string" && option.trim()
    ) &&
    new Set(q.o.map(normalize)).size === 4 &&
    Number.isInteger(q.c) &&
    q.c >= 0 &&
    q.c <= 3 &&
    typeof q.e === "string" &&
    q.e.trim().length >= 20
  );
}

function cleanQuestions(list, exclude, count) {
  const seen = [...exclude];
  const output = [];

  for (const q of Array.isArray(list) ? list : []) {
    if (!validQuestion(q)) continue;
    if (seen.some(old => isSimilar(old, q.q))) continue;

    const levels = {
      "Dễ": 1,
      "Trung bình": 2,
      "Khó": 3
    };

    const question = {
      q: q.q.trim(),
      o: q.o.map(option => option.trim()),
      c: q.c,
      l: [1, 2, 3].includes(q.l) ? q.l : levels[q.l] || 2,
      e: q.e.trim(),
      t: typeof q.t === "string" ? q.t.trim() : ""
    };

    output.push(question);
    seen.push(question.q);

    if (output.length >= count) break;
  }

  return output;
}

function createPrompt({ text, count, level, subject, exclude }) {
  const difficulty = level === "Trộn tất cả"
    ? "Phân bố hợp lý giữa Dễ, Trung bình và Khó."
    : `Tất cả câu hỏi ở mức ${level}.`;

  return `Bạn là giáo viên soạn đề trắc nghiệm bằng tiếng Việt.

Dựa CHỈ vào tài liệu, hãy tạo ${count} câu hỏi MỚI
thuộc chủ đề "${subject || "Chưa xác định"}".

YÊU CẦU:
- Đúng 4 đáp án mỗi câu, chỉ 1 đáp án đúng.
- Kiểm tra khái niệm, chức năng, phân biệt, nguyên nhân-kết quả,
  chọn phát biểu đúng nhất hoặc tình huống áp dụng.
- Không tạo câu điền từ, che từ hoặc chỗ trống.
- Đáp án nhiễu hợp lý, cùng chủ đề.
- Không dùng thông tin ngoài tài liệu.
- Không tạo câu mơ hồ, trùng câu hoặc trùng ý trong cùng đề.
- Lời giải ít nhất 20 ký tự, giải thích rõ vì sao đáp án đúng.
- ${difficulty}

CÁC CÂU ĐÃ TẠO, TUYỆT ĐỐI KHÔNG LẶP:
${JSON.stringify(exclude)}

Không chỉ đổi vài từ, đảo đáp án hay diễn đạt lại cùng ý.
Hãy chọn mục kiến thức hoặc tình huống khác trong tài liệu.
Nếu hết nội dung mới, trả ít câu hơn và giải thích trong note.
Không bịa kiến thức để đủ số câu.

Chỉ trả JSON hợp lệ, không Markdown:
{
  "questions": [
    {
      "q": "Nội dung câu hỏi",
      "o": ["Đáp án A", "Đáp án B", "Đáp án C", "Đáp án D"],
      "c": 0,
      "l": 2,
      "e": "Lời giải chi tiết",
      "t": "Chủ đề nhỏ"
    }
  ],
  "note": ""
}

c: chỉ số đáp án đúng từ 0 đến 3.
l: 1 = Dễ, 2 = Trung bình, 3 = Khó.

TÀI LIỆU:
${text}`;
}

function parseQuiz(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("AI không trả nội dung.");
  }

  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  const quiz = JSON.parse(text);

  if (!quiz || !Array.isArray(quiz.questions)) {
    throw new Error("AI trả sai cấu trúc JSON.");
  }

  return quiz;
}

async function postJSON(url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...headers
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = new Error("Provider HTTP " + response.status);
      error.status = response.status;
      throw error;
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function requestGemini(provider, prompt, timeoutMs) {
  const generationConfig = {
    responseMimeType: "application/json"
  };

  // thinkingLevel dành cho Gemini 3 trở lên.
  if (
    /^gemini-[3-9]/i.test(provider.model) &&
    ["minimal", "low", "medium", "high"].includes(provider.thinking)
  ) {
    generationConfig.thinkingConfig = {
      thinkingLevel: provider.thinking
    };
  }

  // Giữ temperature mặc định với Gemini 3.
  if (!/^gemini-[3-9]/i.test(provider.model)) {
    generationConfig.temperature = 0.7;
  }

  const model = provider.model.replace(/^models\//, "");

  const data = await postJSON(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { "x-goog-api-key": provider.key },
    {
      contents: [{
        role: "user",
        parts: [{ text: prompt }]
      }],
      generationConfig
    },
    timeoutMs
  );

  const raw = data.candidates?.[0]?.content?.parts
    ?.filter(part => !part.thought)
    .map(part => part.text || "")
    .join("");

  return parseQuiz(raw);
}

async function requestGroq(provider, prompt, timeoutMs) {
  const data = await postJSON(
    "https://api.groq.com/openai/v1/chat/completions",
    { Authorization: "Bearer " + provider.key },
    {
      model: provider.model,
      messages: [
        {
          role: "system",
          content: "Bạn soạn đề trắc nghiệm. Chỉ trả JSON hợp lệ."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.7
    },
    timeoutMs
  );

  return parseQuiz(data.choices?.[0]?.message?.content);
}

function getProviders() {
  const providers = [];

  const geminiKey = env("GEMINI_API_KEY");
  const primary = env("GEMINI_MODEL");
  const fallback = env("GEMINI_FALLBACK_MODEL");

  if (geminiKey && primary && primary.toLowerCase() !== "none") {
    providers.push({
      type: "gemini",
      model: primary,
      key: geminiKey
    });
  }

  if (
    geminiKey &&
    fallback &&
    fallback.toLowerCase() !== "none" &&
    fallback !== primary
  ) {
    providers.push({
      type: "gemini",
      model: fallback,
      key: geminiKey,
      thinking: env("GEMINI_FALLBACK_THINKING").toLowerCase()
    });
  }

  const groqKey = env("GROQ_API_KEY");
  const groqModel = env("GROQ_MODEL");

  if (groqKey && groqModel && groqModel.toLowerCase() !== "none") {
    providers.push({
      type: "groq",
      model: groqModel,
      key: groqKey
    });
  }

  return providers;
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") return reply(204, {});

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
    return reply(400, { error: "Dữ liệu gửi lên không hợp lệ." });
  }

  const text = typeof input.text === "string"
    ? input.text.trim().slice(0, 12000)
    : "";

  const subject = typeof input.subject === "string"
    ? input.subject.trim().slice(0, 300)
    : "";

  const level = input.level;
  const requested = Number(input.count);

  const count = Number.isFinite(requested)
    ? Math.min(Math.max(Math.floor(requested), 1), 50)
    : 10;

  const exclude = Array.isArray(input.exclude)
    ? input.exclude
        .filter(q => typeof q === "string" && q.trim())
        .slice(-200)
        .map(q => q.trim().slice(0, 700))
    : [];

  if (text.length < 100) {
    return reply(400, {
      error: "Tài liệu cần ít nhất 100 ký tự."
    });
  }

  if (!LEVELS.has(level)) {
    return reply(400, {
      error: "Mức độ câu hỏi không hợp lệ."
    });
  }

  const providers = getProviders();

  if (!providers.length) {
    return reply(500, {
      error: "Chưa có cặp API key và model hợp lệ trong cấu hình."
    });
  }

  const questions = [];
  let note = "";
  let receivedResponse = false;

  // Giới hạn thời gian của một lần gọi hàm.
  const deadline = Date.now() + 50000;

  for (let i = 0; i < providers.length; i++) {
    if (questions.length >= count) break;

    const remainingMs = deadline - Date.now();
    if (remainingMs < 2000) break;

    const provider = providers[i];
    const providersLeft = providers.length - i;

    // Chừa thời gian cho dịch vụ dự phòng.
    const timeoutMs = Math.min(
      35000,
      Math.max(1000, Math.floor(remainingMs / providersLeft))
    );

    const allExcluded = [
      ...exclude,
      ...questions.map(q => q.q)
    ];

    const prompt = createPrompt({
      text,
      count: count - questions.length,
      level,
      subject,
      exclude: allExcluded
    });

    try {
      const quiz = provider.type === "groq"
        ? await requestGroq(provider, prompt, timeoutMs)
        : await requestGemini(provider, prompt, timeoutMs);

      receivedResponse = true;

      const fresh = cleanQuestions(
        quiz.questions,
        allExcluded,
        count - questions.length
      );

      questions.push(...fresh);

      if (typeof quiz.note === "string" && quiz.note.trim()) {
        note = quiz.note.trim();
      }
    } catch (error) {
      // Không ghi API key hoặc nội dung tài liệu vào log.
      console.error("Quiz provider failed:", {
        provider: provider.type,
        model: provider.model,
        status: error.status || null,
        type: error.name
      });
    }
  }

  if (!questions.length && !receivedResponse) {
    return reply(502, {
      error:
        "Các dịch vụ AI đều chưa tạo được đề. Kiểm tra API key, model và hạn mức rồi thử lại."
    });
  }

  return reply(200, {
    questions,
    note: questions.length < count
      ? [
          `Tạo được ${questions.length}/${count} câu mới hợp lệ.`,
          note || "Tài liệu có thể không đủ nội dung mới hoặc AI chưa trả đủ câu."
        ].join(" ")
      : ""
  });
};

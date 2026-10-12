
/*
=========================================================
 QUIZZ ÔN TẬP - GENERATE QUIZ API
 File: netlify/functions/generate-quiz.js
=========================================================

 ENVIRONMENT VARIABLES:

 GEMINI_API_KEY
 GEMINI_MODEL
 GEMINI_FALLBACK_MODEL
 GEMINI_FALLBACK_THINKING
 GROQ_API_KEY
 GROQ_MODEL

 OUTPUT FORMAT:

 {
   questions: [
     {
       q: "Question",
       o: ["A", "B", "C", "D"],
       c: 0,
       l: 2,
       e: "Explanation",
       t: "Topic",
       k: "Kiến thức"
     }
   ],
   meta: {},
   note: ""
 }

=========================================================
*/

"use strict";

/* =====================================================
   CONFIGURATION
===================================================== */

const LEVELS = new Set([
  "Dễ",
  "Trung bình",
  "Khó",
  "Trộn tất cả"
]);

const QUIZ_MODES = new Set([
  "source",
  "apply"
]);

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const MAX_QUESTIONS = 50;
const MAX_DOCUMENT_CHARS = 16000;
const MAX_TOTAL_TIME = 50000;
const MAX_ATTEMPTS = 12;

const GEMINI_BATCH = 8;
const GROQ_BATCH = 4;

function reply(statusCode, data) {
  return {
    statusCode,
    headers: HEADERS,
    body: statusCode === 204
      ? ""
      : JSON.stringify(data)
  };
}

function env(name) {
  return String(process.env[name] || "").trim();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/* =====================================================
   NORMALIZATION
===================================================== */

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  "la", "gi", "nao", "trong", "nhung",
  "mot", "cac", "cua", "cho", "theo",
  "duoc", "khong", "voi", "va",
  "what", "which", "the", "and",
  "are", "with", "from", "that",
  "this", "following", "question",
  "answer", "correct", "statement"
]);

function semanticWords(text) {
  return normalize(text)
    .split(" ")
    .filter(word =>
      word.length > 2 &&
      !STOP_WORDS.has(word)
    );
}

function jaccard(a, b) {
  if (!a.size || !b.size) {
    return 0;
  }

  let common = 0;

  for (const item of a) {
    if (b.has(item)) {
      common++;
    }
  }

  return common / (
    a.size + b.size - common
  );
}

function bigrams(text) {
  const words = semanticWords(text);
  const result = new Set();

  for (let i = 0; i < words.length - 1; i++) {
    result.add(
      words[i] + " " + words[i + 1]
    );
  }

  return result;
}

/* =====================================================
   ANTI-DUPLICATION
===================================================== */

function isSimilar(a, b) {
  const first = normalize(a);
  const second = normalize(b);

  if (!first || !second) {
    return false;
  }

  if (first === second) {
    return true;
  }

  const shorter = first.length < second.length
    ? first
    : second;

  const longer = first.length < second.length
    ? second
    : first;

  if (
    shorter.length >= 40 &&
    longer.includes(shorter) &&
    shorter.length / longer.length >= 0.80
  ) {
    return true;
  }

  const wordScore = jaccard(
    new Set(semanticWords(first)),
    new Set(semanticWords(second))
  );

  const bigramScore = jaccard(
    bigrams(first),
    bigrams(second)
  );

  return (
    wordScore >= 0.84 ||
    bigramScore >= 0.80 ||
    (
      wordScore >= 0.78 &&
      bigramScore >= 0.65
    )
  );
}

/* =====================================================
   VALIDATE QUESTIONS
===================================================== */

function validQuestion(q) {
  return Boolean(
    q &&
    typeof q.q === "string" &&
    q.q.trim().length >= 8 &&

    !/điền từ|chỗ trống|fill in the blank|fill the blank|_{3,}/i
      .test(q.q) &&

    Array.isArray(q.o) &&
    q.o.length === 4 &&

    q.o.every(option =>
      typeof option === "string" &&
      option.trim().length > 0
    ) &&

    new Set(
      q.o.map(normalize)
    ).size === 4 &&

    Number.isInteger(q.c) &&
    q.c >= 0 &&
    q.c <= 3 &&

    typeof q.e === "string" &&
    q.e.trim().length >= 20
  );
}

function normalizeLevel(value) {
  if ([1, 2, 3].includes(value)) {
    return value;
  }

  const levels = {
    "Dễ": 1,
    "Trung bình": 2,
    "Khó": 3,
    "Easy": 1,
    "Medium": 2,
    "Hard": 3
  };

  return levels[value] || 2;
}

function normalizeKind(value) {
  const text = normalize(value);

  if (
    /van dung|tinh huong|ap dung|application|scenario/
      .test(text)
  ) {
    return "Vận dụng";
  }

  return "Kiến thức";
}

function cleanQuestions(
  list,
  exclude,
  quizMode
) {
  const output = [];
  const seen = [...exclude];

  for (
    const q of Array.isArray(list)
      ? list
      : []
  ) {
    if (!validQuestion(q)) {
      continue;
    }

    if (
      seen.some(old =>
        isSimilar(old, q.q)
      )
    ) {
      continue;
    }

    const question = {
      q: q.q.trim(),

      o: q.o.map(option =>
        option.trim()
      ),

      c: q.c,

      l: normalizeLevel(q.l),

      e: q.e.trim(),

      t: typeof q.t === "string"
        ? q.t.trim()
        : "",

      k: normalizeKind(q.k)
    };

    if (
      quizMode === "source" &&
      question.k === "Vận dụng"
    ) {
      continue;
    }

    output.push(question);
    seen.push(question.q);
  }

  return output;
}

/* =====================================================
   LANGUAGE DETECTION
===================================================== */

function detectLanguage(text) {
  const sample = String(text || "")
    .slice(0, 8000);

  const vietnameseChars = (
    sample.match(
      /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/gi
    ) || []
  ).length;

  const englishWords = (
    sample.match(
      /\b(the|is|are|was|were|and|of|to|in|for|with|that|this|from|which|what|how|when|where)\b/gi
    ) || []
  ).length;

  if (vietnameseChars >= 3) {
    return "vi";
  }

  if (englishWords >= 3) {
    return "en";
  }

  return "same";
}

function languageInstruction(language) {
  if (language === "vi") {
    return `
All natural-language content must be Vietnamese.
Questions, options, explanations and topics
must be written in Vietnamese.
Do not translate into English.
`;
  }

  if (language === "en") {
    return `
All natural-language content must be English.
Questions, options, explanations and topics
must be written in English.
Do not translate into Vietnamese.
`;
  }

  return `
Preserve the original language
of the supplied source document.
`;
}

/* =====================================================
   DIFFICULTY
===================================================== */

function difficultyPlan(count, level) {
  if (level !== "Trộn tất cả") {
    return {
      1: level === "Dễ" ? count : 0,
      2: level === "Trung bình" ? count : 0,
      3: level === "Khó" ? count : 0
    };
  }

  const base = Math.floor(count / 3);
  const remainder = count % 3;

  return {
    1: base,
    2: base + (remainder >= 1 ? 1 : 0),
    3: base + (remainder >= 2 ? 1 : 0)
  };
}

function countLevels(questions) {
  return {
    1: questions.filter(q => q.l === 1).length,
    2: questions.filter(q => q.l === 2).length,
    3: questions.filter(q => q.l === 3).length
  };
}

function enoughForTarget(
  questions,
  count,
  level
) {
  if (level !== "Trộn tất cả") {
    const target = normalizeLevel(level);

    return questions.filter(
      q => q.l === target
    ).length >= count;
  }

  const plan = difficultyPlan(count, level);
  const current = countLevels(questions);

  return (
    current[1] >= plan[1] &&
    current[2] >= plan[2] &&
    current[3] >= plan[3]
  );
}

function selectBalancedQuestions(
  questions,
  count,
  level
) {
  const plan = difficultyPlan(count, level);

  if (level !== "Trộn tất cả") {
    return questions
      .filter(q => q.l === normalizeLevel(level))
      .slice(0, count);
  }

  const selected = [];

  for (const l of [1, 2, 3]) {
    selected.push(
      ...questions
        .filter(q => q.l === l)
        .slice(0, plan[l])
    );
  }

  const used = new Set(
    selected.map(q => normalize(q.q))
  );

  // Nếu AI không phân bố đủ độ khó,
  // tận dụng các câu hợp lệ còn lại.
  if (selected.length < count) {
    const extra = questions.filter(
      q => !used.has(normalize(q.q))
    );

    selected.push(
      ...extra.slice(0, count - selected.length)
    );
  }

  return selected.slice(0, count);
}

/* =====================================================
   APPLICATION QUESTIONS
===================================================== */

function applicationTarget(count, quizMode) {
  if (quizMode === "source") {
    return 0;
  }

  return Math.max(
    1,
    Math.round(count * 0.20)
  );
}

function rebalanceApplication(
  finalQuestions,
  pool,
  count,
  quizMode
) {
  if (quizMode === "source") {
    return finalQuestions.filter(
      q => q.k !== "Vận dụng"
    );
  }

  const target = applicationTarget(
    count,
    quizMode
  );

  const maxApplication = Math.max(
    target,
    Math.ceil(count * 0.25)
  );

  const output = [...finalQuestions];

  let appCount = output.filter(
    q => q.k === "Vận dụng"
  ).length;

  if (appCount <= maxApplication) {
    return output;
  }

  for (
    let i = output.length - 1;
    i >= 0 && appCount > maxApplication;
    i--
  ) {
    if (output[i].k !== "Vận dụng") {
      continue;
    }

    const replacement = pool.find(q =>
      q.k === "Kiến thức" &&
      q.l === output[i].l &&
      !output.some(old =>
        normalize(old.q) === normalize(q.q)
      )
    );

    if (replacement) {
      output[i] = replacement;
      appCount--;
    }
  }

  return output;
}

/* =====================================================
   API PROVIDERS
===================================================== */

function getProviders() {
  const providers = [];

  const geminiKey = env("GEMINI_API_KEY");
  const primary = env("GEMINI_MODEL");
  const fallback = env("GEMINI_FALLBACK_MODEL");

  const thinking = env(
    "GEMINI_FALLBACK_THINKING"
  ).toLowerCase();

  if (
    geminiKey &&
    primary &&
    primary.toLowerCase() !== "none"
  ) {
    providers.push({
      type: "gemini",
      model: primary,
      key: geminiKey,
      thinking
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
      thinking
    });
  }

  const groqKey = env("GROQ_API_KEY");
  const groqModel = env("GROQ_MODEL");

  if (
    groqKey &&
    groqModel &&
    groqModel.toLowerCase() !== "none"
  ) {
    providers.push({
      type: "groq",
      model: groqModel,
      key: groqKey
    });
  }

  return providers;
}

/* =====================================================
   PROMPT
===================================================== */

function createPrompt({
  text,
  count,
  level,
  subject,
  exclude,
  quizMode,
  language,
  difficultyNeeded,
  applicationNeeded,
  compact
}) {
  const askCount = Math.min(
    compact ? 6 : 12,
    Math.max(
      count + 2,
      Math.ceil(count * 1.25)
    )
  );

  const modeRule = quizMode === "source"
    ? `
SOURCE MODE:

- Create questions based directly on the document.
- Every correct answer must be verifiable
  from the supplied content.
- Do not introduce outside knowledge.
- Do not invent new scenarios.
- Do not create application questions.
- Every question must use "k": "Kiến thức".
`
    : `
APPLICATION MODE:

- Target about 80% knowledge questions.
- Target about 20% application questions.
- Approximately ${applicationNeeded}
  application questions are still needed.
- Application scenarios must be grounded
  in knowledge from the document.
- Do not invent unsupported facts.
- Use "k": "Vận dụng" for application questions.
- Use "k": "Kiến thức" for knowledge questions.
`;

  const difficultyRule = level === "Trộn tất cả"
    ? `
Balance difficulty levels.

Still needed:
Easy: ${difficultyNeeded[1]}
Medium: ${difficultyNeeded[2]}
Hard: ${difficultyNeeded[3]}

Prioritize the levels that are missing.
`
    : `
All questions must have difficulty:
${level}
`;

  const excluded = exclude
    .slice(compact ? -12 : -35)
    .map(q => String(q).slice(0, 300));

  return `
You are a professional teacher specializing
in high-quality multiple-choice quizzes.

==================================================
LANGUAGE
==================================================

${languageInstruction(language)}

IMPORTANT:
Internal JSON keys must remain unchanged.
The values "Kiến thức" and "Vận dụng"
must also remain in Vietnamese.

==================================================
TASK
==================================================

Create approximately ${askCount}
NEW multiple-choice questions.

Subject:
${subject || "Source document"}

==================================================
QUESTION MODE
==================================================

${modeRule}

==================================================
DIFFICULTY
==================================================

${difficultyRule}

==================================================
MANDATORY RULES
==================================================

1. Exactly 4 answer options per question.

2. Exactly 1 correct answer.

3. Do not create fill-in-the-blank questions.

4. Do not use blank underscores.

5. Do not introduce unsupported knowledge.

6. Avoid duplicate questions.

7. Do not merely reword an existing question.

8. Do not just rearrange answer options.

9. Answer choices must be distinct.

10. Wrong choices must be plausible.

11. The explanation must have at least
    20 characters.

12. Explain why the correct answer is correct.

13. Use diverse question styles:
    - Concepts
    - Features
    - Functions
    - Purposes
    - Roles
    - Comparisons
    - Causes and effects
    - Relationships
    - Processes
    - Conditions
    - Correct statements
    - Direct reasoning
    - Application when allowed

14. Do not create only definition questions.

15. Preserve the language of the document.

==================================================
DUPLICATE PREVENTION
==================================================

Previously used questions:

${JSON.stringify(excluded)}

Do not repeat these questions or their ideas.

==================================================
OUTPUT JSON
==================================================

Return valid JSON only.

No Markdown.
No extra text.

Use this structure:

{
  "questions": [
    {
      "q": "Question text",
      "o": [
        "Option A",
        "Option B",
        "Option C",
        "Option D"
      ],
      "c": 0,
      "l": 2,
      "e": "Detailed explanation",
      "t": "Topic",
      "k": "Kiến thức"
    }
  ],
  "note": ""
}

RULES:

c:
0 = A
1 = B
2 = C
3 = D

l:
1 = Easy
2 = Medium
3 = Hard

k:
"Kiến thức" or "Vận dụng"

==================================================
SOURCE DOCUMENT
==================================================

${text}
`;
}

/* =====================================================
   JSON PARSER
===================================================== */

function parseQuiz(raw) {
  if (
    typeof raw !== "string" ||
    !raw.trim()
  ) {
    throw new Error("EMPTY_AI_RESPONSE");
  }

  let content = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");

  if (first >= 0 && last > first) {
    content = content.slice(first, last + 1);
  }

  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("INVALID_AI_JSON");
  }

  if (
    !parsed ||
    !Array.isArray(parsed.questions)
  ) {
    throw new Error("INVALID_QUIZ_STRUCTURE");
  }

  return parsed;
}

/* =====================================================
   HTTP ERROR HANDLING
===================================================== */

function providerErrorInfo(raw) {
  try {
    const data = JSON.parse(raw);
    const err = data?.error || {};

    const code = String(
      err.status ||
      err.code ||
      err.type ||
      "UNKNOWN"
    );

    // Chỉ ghi mã lỗi an toàn.
    // Không ghi raw response hoặc API key.
    return code
      .replace(/[^a-zA-Z0-9_ -]/g, "")
      .slice(0, 80);

  } catch {
    return "UNKNOWN";
  }
}

async function postJSON(
  url,
  headers,
  body,
  timeoutMs
) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

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

    const raw = await response.text();

    if (!response.ok) {
      const error = new Error(
        "PROVIDER_HTTP_ERROR"
      );

      error.status = response.status;

      error.providerCode = providerErrorInfo(
        raw
      );

      throw error;
    }

    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(
        "INVALID_PROVIDER_RESPONSE"
      );
    }

  } finally {
    clearTimeout(timer);
  }
}

/* =====================================================
   GEMINI API
===================================================== */

async function requestGemini(
  provider,
  prompt,
  timeoutMs,
  count
) {
  const model = provider.model.replace(
    /^models\//,
    ""
  );

  const generationConfig = {
    responseMimeType: "application/json",

    maxOutputTokens: clamp(
      count * 450,
      2048,
      8192
    )
  };

  // Gemini 3+ có thể dùng thinkingLevel.
  if (
    /^gemini-[3-9]/i.test(model) &&
    ["minimal", "low", "medium", "high"]
      .includes(provider.thinking)
  ) {
    generationConfig.thinkingConfig = {
      thinkingLevel: provider.thinking
    };
  }

  if (!/^gemini-[3-9]/i.test(model)) {
    generationConfig.temperature = 0.7;
  }

  const url =
    "https://generativelanguage.googleapis.com" +
    "/v1beta/models/" +
    encodeURIComponent(model) +
    ":generateContent";

  const data = await postJSON(
    url,

    {
      "x-goog-api-key": provider.key
    },

    {
      contents: [
        {
          role: "user",

          parts: [
            {
              text: prompt
            }
          ]
        }
      ],

      generationConfig
    },

    timeoutMs
  );

  const parts =
    data?.candidates?.[0]?.content?.parts || [];

  const output = parts
    .filter(part => !part.thought)
    .map(part => part.text || "")
    .join("");

  return parseQuiz(output);
}

/* =====================================================
   GROQ API
===================================================== */

async function requestGroq(
  provider,
  prompt,
  timeoutMs,
  count
) {
  const data = await postJSON(
    "https://api.groq.com/openai/v1/chat/completions",

    {
      Authorization: `Bearer ${provider.key}`
    },

    {
      model: provider.model,

      messages: [
        {
          role: "system",

          content:
            "Create multiple-choice questions from the supplied document. Preserve source language. Return JSON only."
        },

        {
          role: "user",
          content: prompt
        }
      ],

      response_format: {
        type: "json_object"
      },

      temperature: 0.6,

      max_tokens: clamp(
        count * 400,
        1200,
        3000
      )
    },

    timeoutMs
  );

  return parseQuiz(
    data?.choices?.[0]?.message?.content
  );
}

/* =====================================================
   ERROR CLASSIFICATION
===================================================== */

function errorCategory(error) {
  if (error.name === "AbortError") {
    return "TIMEOUT";
  }

  switch (error.status) {
    case 400:
      return "INVALID_REQUEST";

    case 401:
    case 403:
      return "AUTH_OR_PERMISSION";

    case 404:
      return "MODEL_NOT_FOUND";

    case 413:
      return "PAYLOAD_TOO_LARGE";

    case 429:
      return "RATE_LIMIT";

    case 500:
    case 502:
    case 503:
      return "PROVIDER_UNAVAILABLE";

    default:
      return error.message || "UNKNOWN";
  }
}

/* =====================================================
   MAIN NETLIFY FUNCTION
===================================================== */

exports.handler = async function handler(event) {

  /* ---------------------------
     CORS
  --------------------------- */

  if (event.httpMethod === "OPTIONS") {
    return reply(204, {});
  }

  if (event.httpMethod !== "POST") {
    return reply(405, {
      error: "Chỉ hỗ trợ POST."
    });
  }

  /* ---------------------------
     PARSE INPUT
  --------------------------- */

  let input;

  try {
    input = JSON.parse(
      event.body || "{}"
    );
  } catch {
    return reply(400, {
      error: "Dữ liệu JSON không hợp lệ."
    });
  }

  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return reply(400, {
      error: "Dữ liệu gửi lên không hợp lệ."
    });
  }

  /* ---------------------------
     DOCUMENT
  --------------------------- */

  const text =
    typeof input.text === "string"
      ? input.text
          .trim()
          .slice(0, MAX_DOCUMENT_CHARS)
      : "";

  /* ---------------------------
     SUBJECT
  --------------------------- */

  const subject =
    typeof input.subject === "string"
      ? input.subject
          .trim()
          .slice(0, 300)
      : "";

  /* ---------------------------
     LEVEL
  --------------------------- */

  const level = input.level;

  /* ---------------------------
     QUIZ MODE
  --------------------------- */

  const quizMode = QUIZ_MODES.has(
    input.quizMode
  )
    ? input.quizMode
    : "source";

  /* ---------------------------
     NUMBER OF QUESTIONS
  --------------------------- */

  const requested = Number(
    input.count
  );

  const count = Number.isFinite(requested)
    ? clamp(
        Math.floor(requested),
        1,
        MAX_QUESTIONS
      )
    : 10;

  /* ---------------------------
     EXCLUDED QUESTIONS
  --------------------------- */

  const exclude =
    Array.isArray(input.exclude)
      ? input.exclude
          .filter(q =>
            typeof q === "string" &&
            q.trim()
          )
          .slice(-220)
          .map(q =>
            q.trim().slice(0, 700)
          )
      : [];

  /* ---------------------------
     VALIDATE INPUT
  --------------------------- */

  if (text.length < 100) {
    return reply(400, {
      error:
        "Tài liệu cần ít nhất 100 ký tự."
    });
  }

  if (!LEVELS.has(level)) {
    return reply(400, {
      error:
        "Mức độ câu hỏi không hợp lệ."
    });
  }

  /* ---------------------------
     PROVIDERS
  --------------------------- */

  const providers = getProviders();

  if (!providers.length) {
    return reply(500, {
      error:
        "Chưa có cặp API key và model hợp lệ trong cấu hình."
    });
  }

  /* ---------------------------
     INITIAL STATE
  --------------------------- */

  const language = detectLanguage(text);
  const questions = [];
  const failures = [];

  const disabledProviders = new Set();

  const deadline =
    Date.now() + MAX_TOTAL_TIME;

  const maxAttempts = Math.max(
    MAX_ATTEMPTS,
    providers.length * 3
  );

  const plan = difficultyPlan(
    count,
    level
  );

  const appTarget = applicationTarget(
    count,
    quizMode
  );

  let attempts = 0;
  let note = "";

  /* =================================================
     GENERATION LOOP
  ================================================= */

  while (
    !enoughForTarget(
      questions,
      count,
      level
    ) &&

    attempts < maxAttempts &&

    Date.now() < deadline - 4500
  ) {
    let progress = false;
    let activeProviders = 0;

    for (const provider of providers) {

      if (
        enoughForTarget(
          questions,
          count,
          level
        )
      ) {
        break;
      }

      if (
        attempts >= maxAttempts ||
        Date.now() >= deadline - 4500
      ) {
        break;
      }

      const providerId =
        provider.type + ":" + provider.model;

      if (
        disabledProviders.has(providerId)
      ) {
        continue;
      }

      activeProviders++;

      const isGroq =
        provider.type === "groq";

      /* ---------------------------
         CURRENT DIFFICULTY
      --------------------------- */

      const current = countLevels(
        questions
      );

      const difficultyNeeded = {
        1: Math.max(
          0,
          plan[1] - current[1]
        ),

        2: Math.max(
          0,
          plan[2] - current[2]
        ),

        3: Math.max(
          0,
          plan[3] - current[3]
        )
      };

      /* ---------------------------
         REMAINING QUESTIONS
      --------------------------- */

      const remaining = Math.max(
        0,
        count - questions.length
      );

      const missingByLevel =
        difficultyNeeded[1] +
        difficultyNeeded[2] +
        difficultyNeeded[3];

      const needed = level === "Trộn tất cả"
        ? missingByLevel
        : remaining;

      if (needed <= 0) {
        break;
      }

      /* ---------------------------
         BATCH SIZE
      --------------------------- */

      const batch = Math.min(
        needed,
        isGroq
          ? GROQ_BATCH
          : GEMINI_BATCH
      );

      /* ---------------------------
         APPLICATION COUNT
      --------------------------- */

      const appCurrent = questions.filter(
        q => q.k === "Vận dụng"
      ).length;

      const appNeeded = Math.max(
        0,
        appTarget - appCurrent
      );

      /* ---------------------------
         LIMIT DOCUMENT SIZE
      --------------------------- */

      // Groq thường có giới hạn thấp hơn.
      // Sử dụng đoạn tài liệu ngắn hơn.
      const source = isGroq
        ? text.slice(0, 4500)
        : text.slice(0, 14000);

      /* ---------------------------
         EXCLUDED QUESTIONS
      --------------------------- */

      const allExcluded = [
        ...exclude,
        ...questions.map(q => q.q)
      ];

      /* ---------------------------
         BUILD PROMPT
      --------------------------- */

      const prompt = createPrompt({
        text: source,

        count: batch,

        level,

        subject,

        exclude: allExcluded,

        quizMode,

        language,

        difficultyNeeded,

        applicationNeeded: appNeeded,

        compact: isGroq
      });

      /* ---------------------------
         TIMEOUT
      --------------------------- */

      const remainingMs =
        deadline - Date.now();

      const timeoutMs = Math.min(
        24000,
        Math.max(
          3000,
          remainingMs - 2000
        )
      );

      attempts++;

      /* ---------------------------
         REQUEST AI
      --------------------------- */

      try {
        const result = isGroq
          ? await requestGroq(
              provider,
              prompt,
              timeoutMs,
              batch
            )

          : await requestGemini(
              provider,
              prompt,
              timeoutMs,
              batch
            );

        /* -------------------------
           CLEAN QUESTIONS
        ------------------------- */

        const fresh = cleanQuestions(
          result.questions,
          allExcluded,
          quizMode
        );

        if (fresh.length > 0) {
          questions.push(
            ...fresh.slice(
              0,
              Math.max(
                0,
                count - questions.length
              )
            )
          );

          progress = true;

          if (
            typeof result.note === "string" &&
            result.note.trim()
          ) {
            note = result.note.trim();
          }

          // Có câu hợp lệ thì tiếp tục
          // vòng sau để bù câu thiếu.
          break;
        }

        console.warn(
          "Quiz provider returned no usable questions",
          {
            provider: provider.type,
            model: provider.model,
            returned: result.questions.length
          }
        );

      } catch (error) {

        const info = {
          provider: provider.type,
          model: provider.model,
          status: error.status || null,
          category: errorCategory(error),
          providerCode:
            error.providerCode || null
        };

        // Không ghi API key hoặc tài liệu.
        console.error(
          "Quiz provider failed:",
          info
        );

        failures.push(info);

        /* -------------------------
           DISABLE BAD PROVIDER
        ------------------------- */

        if (
          [400, 401, 403, 404, 413]
            .includes(error.status)
        ) {
          disabledProviders.add(
            providerId
          );
        }
      }
    }

    /* ---------------------------
       PREVENT USELESS RETRIES
    --------------------------- */

    if (
      !progress ||
      activeProviders === 0
    ) {
      break;
    }
  }

  /* =================================================
     ALL PROVIDERS FAILED
  ================================================= */

  if (!questions.length) {

    const statuses = failures.map(
      item => item.status
    );

    let message =
      "Các dịch vụ AI đều chưa tạo được đề.";

    if (statuses.includes(400)) {
      message +=
        " Có yêu cầu API không hợp lệ (400).";
    }

    if (statuses.includes(413)) {
      message +=
        " Một yêu cầu vượt giới hạn dữ liệu (413).";
    }

    if (statuses.includes(429)) {
      message +=
        " Đã gặp giới hạn sử dụng API (429).";
    }

    if (
      statuses.includes(401) ||
      statuses.includes(403)
    ) {
      message +=
        " API key hoặc quyền truy cập gặp vấn đề.";
    }

    message +=
      " Hãy kiểm tra Netlify Function Logs.";

    return reply(502, {
      error: message
    });
  }

  /* =================================================
     SELECT FINAL QUESTIONS
  ================================================= */

  let finalQuestions =
    selectBalancedQuestions(
      questions,
      count,
      level
    );

  finalQuestions =
    rebalanceApplication(
      finalQuestions,
      questions,
      count,
      quizMode
    );

  if (!finalQuestions.length) {
    return reply(502, {
      error:
        "AI chưa tạo được câu hỏi hợp lệ."
    });
  }

  /* =================================================
     METADATA
  ================================================= */

  const finalLevels = countLevels(
    finalQuestions
  );

  const applicationQuestions =
    finalQuestions.filter(
      q => q.k === "Vận dụng"
    ).length;

  const knowledgeQuestions =
    finalQuestions.length -
    applicationQuestions;

  /* =================================================
     FINAL RESPONSE
  ================================================= */

  return reply(200, {

    questions: finalQuestions,

    meta: {
      requested: count,

      generated:
        finalQuestions.length,

      easy:
        finalLevels[1],

      medium:
        finalLevels[2],

      hard:
        finalLevels[3],

      knowledgeQuestions,

      applicationQuestions,

      sourceLanguage:
        language,

      quizMode,

      attempts
    },

    note:
      finalQuestions.length < count

        ? [
            `Tạo được ${finalQuestions.length}/${count} câu hợp lệ.`,

            note ||
            "Có thể chưa đủ thời gian, nội dung hoặc hạn mức API để tạo đủ câu."
          ].join(" ")

        : ""
  });
};

/*
 * netlify/functions/generate-quiz.js
 *
 * Biến môi trường:
 * GEMINI_API_KEY
 * GEMINI_MODEL
 * GEMINI_FALLBACK_MODEL
 * GEMINI_FALLBACK_THINKING
 * GROQ_API_KEY
 * GROQ_MODEL
 *
 * Mục tiêu bản này:
 * - Cố gắng trả ĐỦ số câu yêu cầu (1-50) bằng nhiều vòng bổ sung.
 * - Chống trùng mạnh hơn trong cùng quiz và với danh sách exclude từ frontend.
 * - Tăng câu VẬN DỤNG/TÌNH HUỐNG nhưng vẫn chỉ dùng kiến thức trong tài liệu.
 */

const LEVELS = new Set(["Dễ", "Trung bình", "Khó", "Trộn tất cả"]);

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
  "la", "gi", "nao", "sau", "day", "trong", "cac", "mot", "nhung", "va", "voi",
  "cua", "cho", "khi", "theo", "duoc", "ve", "co", "khong", "dung", "nhat", "hay",
  "phat", "bieu", "lua", "chon", "dap", "an", "noi", "dung", "hoi", "truong", "hop"
]);

function tokenSet(text) {
  return new Set(
    normalize(text)
      .split(" ")
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;

  for (const word of a) {
    if (b.has(word)) common++;
  }

  return common / (a.size + b.size - common);
}

function bigrams(text) {
  const words = normalize(text).split(" ").filter(Boolean);
  const set = new Set();

  for (let i = 0; i < words.length - 1; i++) {
    set.add(words[i] + " " + words[i + 1]);
  }

  return set;
}

function isSimilar(a, b) {
  const first = normalize(a);
  const second = normalize(b);

  if (!first || !second) return false;
  if (first === second) return true;

  // Một câu gần như chứa nguyên câu kia.
  if (first.length >= 35 && second.length >= 35) {
    const shorter = first.length < second.length ? first : second;
    const longer = first.length < second.length ? second : first;

    if (
      longer.includes(shorter) &&
      shorter.length / longer.length >= 0.72
    ) {
      return true;
    }
  }

  const wordScore = jaccard(tokenSet(first), tokenSet(second));
  const bigramScore = jaccard(bigrams(first), bigrams(second));

  return (
    wordScore >= 0.78 ||
    bigramScore >= 0.72 ||
    (wordScore >= 0.70 && bigramScore >= 0.55)
  );
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

    if (seen.some(old => isSimilar(old, q.q))) {
      continue;
    }

    const levels = {
      "Dễ": 1,
      "Trung bình": 2,
      "Khó": 3
    };

    const kindRaw =
      typeof q.k === "string"
        ? q.k.trim().toLowerCase()
        : "";

    const question = {
      q: q.q.trim(),
      o: q.o.map(option => option.trim()),
      c: q.c,
      l: [1, 2, 3].includes(q.l)
        ? q.l
        : levels[q.l] || 2,
      e: q.e.trim(),
      t:
        typeof q.t === "string"
          ? q.t.trim()
          : "",
      k:
        kindRaw.includes("vận") ||
        kindRaw.includes("van") ||
        kindRaw.includes("tình") ||
        kindRaw.includes("tinh")
          ? "Vận dụng"
          : "Kiến thức"
    };

    output.push(question);
    seen.push(question.q);

    if (output.length >= count) break;
  }

  return output;
}

function compactExclude(
  exclude,
  maxItems = 220,
  maxChars = 60000
) {
  const source = Array.isArray(exclude)
    ? exclude.slice(-maxItems)
    : [];

  const output = [];
  let chars = 0;

  for (let i = source.length - 1; i >= 0; i--) {
    const item = String(source[i] || "").slice(0, 700);

    if (!item) continue;

    if (chars + item.length > maxChars) {
      break;
    }

    output.push(item);
    chars += item.length;
  }

  return output.reverse();
}

function createPrompt({
  text,
  count,
  level,
  subject,
  exclude,
  round,
  applicationNeeded = 0
}) {
  const difficulty =
    level === "Trộn tất cả"
      ? "Phân bố hợp lý giữa Dễ, Trung bình và Khó; không dồn hết vào một mức."
      : `Tất cả câu hỏi ở mức ${level}.`;

  /*
   * Xin dư câu để sau khi backend loại:
   * - câu trùng
   * - câu sai format
   * - đáp án lỗi
   * vẫn có khả năng đủ số câu user yêu cầu.
   */
  const askCount = Math.min(
    70,
    Math.max(count, Math.ceil(count * 1.35) + 2)
  );

  const applicationTarget = Math.max(
    applicationNeeded,
    Math.max(1, Math.round(askCount * 0.4))
  );

  const promptExclude = compactExclude(exclude);

  return `Bạn là giáo viên chuyên soạn câu hỏi trắc nghiệm tiếng Việt.

NHIỆM VỤ VÒNG ${round}:

Dựa CHỈ vào TÀI LIỆU bên dưới, hãy tạo ${askCount} câu hỏi MỚI để hệ thống chọn đủ ${count} câu hợp lệ.

Chủ đề:
"${subject || "Chưa xác định"}"

YÊU CẦU BẮT BUỘC:

- Mỗi câu có đúng 4 đáp án.
- Chỉ có 1 đáp án đúng.
- Không tạo câu điền từ.
- Không tạo câu chỗ trống.
- Không che từ bằng dấu gạch.
- Không dùng thông tin ngoài tài liệu.
- Không tự bịa kiến thức để đủ số câu.
- Không tạo hai câu cùng kiểm tra một ý dù diễn đạt khác nhau.
- Không chỉ thay tên nhân vật hoặc đổi vài từ rồi xem là câu mới.
- Không đảo vị trí đáp án rồi xem là câu mới.
- Đáp án nhiễu phải hợp lý và cùng phạm vi kiến thức.
- Lời giải phải từ 20 ký tự trở lên.
- Lời giải cần giải thích rõ vì sao đáp án đúng.
- ${difficulty}

CÁC DẠNG CÂU HỎI NÊN CÓ:

1. Khái niệm.
2. Chức năng.
3. Đặc điểm.
4. Phân biệt hai khái niệm.
5. Nguyên nhân - kết quả.
6. Chọn phát biểu đúng nhất.
7. Nhận diện trường hợp.
8. Tình huống thực tế.
9. Áp dụng kiến thức đã học.
10. Suy luận từ nội dung trong tài liệu.

MỞ RỘNG CÂU VẬN DỤNG:

- Ít nhất ${Math.min(
    applicationTarget,
    askCount
  )}/${askCount} câu phải thuộc dạng VẬN DỤNG hoặc TÌNH HUỐNG.

- Hiện hệ thống còn cần tối thiểu ${applicationNeeded} câu Vận dụng để đạt tỷ lệ mục tiêu.

- Nếu applicationNeeded lớn hơn 0, hãy ưu tiên tạo đủ số câu vận dụng còn thiếu trước.

- Câu vận dụng phải đặt người học vào một tình huống mới rồi yêu cầu áp dụng kiến thức trong tài liệu.

Ví dụ dạng hỏi:

"Trong tình huống trên, phương án nào phù hợp nhất?"

"Nếu trường hợp này xảy ra thì kết quả nào hợp lý nhất?"

"Một doanh nghiệp thực hiện hành động trên thì khái niệm nào giải thích đúng nhất?"

"Kiến thức nào nên được áp dụng trong trường hợp này?"

"Nếu thay đổi điều kiện trên thì điều gì có khả năng xảy ra?"

- Có thể sáng tạo bối cảnh tình huống.

NHƯNG:

Mọi kiến thức dùng để suy ra đáp án phải xuất phát từ tài liệu.

Không được thêm kiến thức bên ngoài.

Không được tạo câu vận dụng giả, ví dụ chỉ thêm:
"Anh A..."
"Bạn B..."
"Công ty C..."
nhưng phần hỏi phía sau vẫn chỉ là định nghĩa y nguyên.

CÁC CÂU ĐÃ CÓ.

TUYỆT ĐỐI KHÔNG LẶP CÂU VÀ KHÔNG LẶP Ý:

${JSON.stringify(promptExclude)}

Hãy ưu tiên:

- mục kiến thức chưa được hỏi
- khái niệm chưa xuất hiện
- mối quan hệ chưa được hỏi
- nguyên nhân chưa được hỏi
- kết quả chưa được hỏi
- ví dụ khác
- tình huống khác
- góc nhìn khác

Nếu một nội dung đã từng được hỏi thì hãy chuyển sang một nội dung khác.

Không chỉ đổi vài từ.

Không chỉ đảo đáp án.

Không chỉ đổi tên nhân vật.

Không chỉ đổi thứ tự câu.

Nếu tài liệu có nhiều phần, hãy phân bố câu hỏi trên nhiều phần khác nhau.

Chỉ trả JSON hợp lệ.

KHÔNG Markdown.

KHÔNG giải thích bên ngoài JSON.

Cấu trúc bắt buộc:

{
  "questions": [
    {
      "q": "Nội dung câu hỏi",
      "o": [
        "Đáp án A",
        "Đáp án B",
        "Đáp án C",
        "Đáp án D"
      ],
      "c": 0,
      "l": 2,
      "e": "Lời giải chi tiết",
      "t": "Chủ đề nhỏ",
      "k": "Kiến thức hoặc Vận dụng"
    }
  ],
  "note": ""
}

Trong đó:

c:
0 = đáp án A
1 = đáp án B
2 = đáp án C
3 = đáp án D

l:
1 = Dễ
2 = Trung bình
3 = Khó

k:
Ghi chính xác:

"Vận dụng"

nếu là câu tình huống / áp dụng kiến thức.

Các câu còn lại ghi:

"Kiến thức"

TÀI LIỆU:

${text}`;
}

function parseQuiz(raw) {
  if (
    typeof raw !== "string" ||
    !raw.trim()
  ) {
    throw new Error("AI không trả nội dung.");
  }

  let text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  /*
   * Một số model đôi lúc vẫn thêm chữ
   * trước hoặc sau JSON.
   *
   * Ta lấy object JSON ngoài cùng.
   */
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");

  if (
    firstBrace >= 0 &&
    lastBrace > firstBrace
  ) {
    text = text.slice(
      firstBrace,
      lastBrace + 1
    );
  }

  const quiz = JSON.parse(text);

  if (
    !quiz ||
    !Array.isArray(quiz.questions)
  ) {
    throw new Error(
      "AI trả sai cấu trúc JSON."
    );
  }

  return quiz;
}

async function postJSON(
  url,
  headers,
  body,
  timeoutMs
) {
  const controller =
    new AbortController();

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

    if (!response.ok) {
      const error = new Error(
        "Provider HTTP " +
        response.status
      );

      error.status = response.status;

      throw error;
    }

    return await response.json();

  } finally {
    clearTimeout(timer);
  }
}

async function requestGemini(
  provider,
  prompt,
  timeoutMs
) {
  const generationConfig = {
    responseMimeType:
      "application/json",

    maxOutputTokens: 8192
  };

  /*
   * thinkingLevel chỉ dùng
   * với Gemini 3 trở lên.
   */
  if (
    /^gemini-[3-9]/i.test(
      provider.model
    ) &&
    [
      "minimal",
      "low",
      "medium",
      "high"
    ].includes(provider.thinking)
  ) {
    generationConfig.thinkingConfig = {
      thinkingLevel:
        provider.thinking
    };
  }

  /*
   * Với model Gemini cũ hơn
   * có thể chỉnh temperature.
   */
  if (
    !/^gemini-[3-9]/i.test(
      provider.model
    )
  ) {
    generationConfig.temperature =
      0.85;
  }

  const model =
    provider.model.replace(
      /^models\//,
      ""
    );

  const data = await postJSON(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent`,

    {
      "x-goog-api-key":
        provider.key
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

  const raw =
    data.candidates?.[0]?.content?.parts
      ?.filter(
        part => !part.thought
      )
      .map(
        part => part.text || ""
      )
      .join("");

  return parseQuiz(raw);
}

async function requestGroq(
  provider,
  prompt,
  timeoutMs
) {
  const data = await postJSON(
    "https://api.groq.com/openai/v1/chat/completions",

    {
      Authorization:
        "Bearer " +
        provider.key
    },

    {
      model: provider.model,

      messages: [
        {
          role: "system",
          content:
            "Bạn soạn đề trắc nghiệm. Chỉ trả JSON hợp lệ."
        },
        {
          role: "user",
          content: prompt
        }
      ],

      response_format: {
        type: "json_object"
      },

      temperature: 0.85,

      max_tokens: 8192
    },

    timeoutMs
  );

  return parseQuiz(
    data.choices?.[0]?.message?.content
  );
}

function getProviders() {
  const providers = [];

  const geminiKey =
    env("GEMINI_API_KEY");

  const primary =
    env("GEMINI_MODEL");

  const fallback =
    env("GEMINI_FALLBACK_MODEL");

  const thinking =
    env(
      "GEMINI_FALLBACK_THINKING"
    ).toLowerCase();

  /*
   * Gemini chính
   */
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

  /*
   * Gemini dự phòng
   */
  if (
    geminiKey &&
    fallback &&
    fallback.toLowerCase() !==
      "none" &&
    fallback !== primary
  ) {
    providers.push({
      type: "gemini",
      model: fallback,
      key: geminiKey,
      thinking
    });
  }

  /*
   * Groq dự phòng tiếp theo
   */
  const groqKey =
    env("GROQ_API_KEY");

  const groqModel =
    env("GROQ_MODEL");

  if (
    groqKey &&
    groqModel &&
    groqModel.toLowerCase() !==
      "none"
  ) {
    providers.push({
      type: "groq",
      model: groqModel,
      key: groqKey
    });
  }

  return providers;
}

exports.handler =
async function handler(event) {

  /*
   * CORS preflight
   */
  if (
    event.httpMethod === "OPTIONS"
  ) {
    return reply(204, {});
  }

  /*
   * Chỉ cho phép POST
   */
  if (
    event.httpMethod !== "POST"
  ) {
    return reply(405, {
      error:
        "Chỉ hỗ trợ POST."
    });
  }

  let input;

  try {
    input = JSON.parse(
      event.body || "{}"
    );
  } catch {
    return reply(400, {
      error:
        "Dữ liệu JSON không hợp lệ."
    });
  }

  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return reply(400, {
      error:
        "Dữ liệu gửi lên không hợp lệ."
    });
  }

  /*
   * Nội dung tài liệu
   */
  const text =
    typeof input.text === "string"
      ? input.text
          .trim()
          .slice(0, 16000)
      : "";

  /*
   * Chủ đề / môn học
   */
  const subject =
    typeof input.subject === "string"
      ? input.subject
          .trim()
          .slice(0, 300)
      : "";

  /*
   * Độ khó
   */
  const level = input.level;

  /*
   * Số câu
   */
  const requested =
    Number(input.count);

  const count =
    Number.isFinite(requested)
      ? Math.min(
          Math.max(
            Math.floor(requested),
            1
          ),
          50
        )
      : 10;

  /*
   * Các câu đã tạo trước đó.
   *
   * Frontend nên gửi danh sách này
   * để hạn chế trùng ở lần tạo
   * thứ 2, 3, 4...
   */
  const exclude =
    Array.isArray(input.exclude)
      ? input.exclude
          .filter(
            q =>
              typeof q === "string" &&
              q.trim()
          )
          .slice(-600)
          .map(
            q =>
              q
                .trim()
                .slice(0, 700)
          )
      : [];

  /*
   * Kiểm tra tài liệu
   */
  if (text.length < 100) {
    return reply(400, {
      error:
        "Tài liệu cần ít nhất 100 ký tự."
    });
  }

  /*
   * Kiểm tra độ khó
   */
  if (!LEVELS.has(level)) {
    return reply(400, {
      error:
        "Mức độ câu hỏi không hợp lệ."
    });
  }

  /*
   * Lấy danh sách AI provider
   */
  const providers =
    getProviders();

  if (!providers.length) {
    return reply(500, {
      error:
        "Chưa có cặp API key và model hợp lệ trong cấu hình."
    });
  }

  const questions = [];

  let note = "";

  let receivedResponse = false;

  let attempts = 0;

  /*
   * Giới hạn tổng thời gian
   * một lần chạy Netlify Function.
   */
  const deadline =
    Date.now() + 50000;

  /*
   * Cho phép nhiều vòng bổ sung.
   */
  const MAX_ATTEMPTS =
    Math.max(
      4,
      providers.length * 2
    );

  /*
   * Nếu AI trả thiếu hoặc có câu
   * bị loại do trùng / lỗi,
   * tiếp tục gọi AI để bù.
   */
  while (
    questions.length < count &&
    attempts < MAX_ATTEMPTS
  ) {

    const remainingMs =
      deadline - Date.now();

    /*
     * Không bắt đầu request mới
     * nếu thời gian còn quá ít.
     */
    if (remainingMs < 4500) {
      break;
    }

    /*
     * Luân phiên provider:
     *
     * Gemini chính
     * → Gemini fallback
     * → Groq
     * → quay lại...
     */
    const provider =
      providers[
        attempts %
        providers.length
      ];

    attempts++;

    /*
     * Danh sách chống trùng
     * gồm:
     *
     * - các câu cũ frontend gửi lên
     * - các câu vừa tạo trong request này
     */
    const allExcluded = [
      ...exclude,
      ...questions.map(q => q.q)
    ];

    /*
     * Còn thiếu bao nhiêu câu
     */
    const needed =
      count -
      questions.length;

    /*
     * Mục tiêu khoảng 40%
     * câu vận dụng.
     */
    const targetApplication =
      Math.max(
        1,
        Math.round(count * 0.4)
      );

    const currentApplication =
      questions.filter(
        q =>
          q.k === "Vận dụng"
      ).length;

    const applicationNeeded =
      Math.max(
        0,
        targetApplication -
        currentApplication
      );

    /*
     * Tạo prompt vòng hiện tại
     */
    const prompt =
      createPrompt({
        text,
        count: needed,
        level,
        subject,
        exclude: allExcluded,
        round: attempts,
        applicationNeeded
      });

    /*
     * Chia thời gian hợp lý
     * cho các vòng còn lại.
     */
    const attemptsLeft =
      Math.max(
        1,
        MAX_ATTEMPTS -
        attempts +
        1
      );

    const timeoutMs =
      Math.min(
        26000,
        Math.max(
          4500,
          Math.floor(
            remainingMs /
            Math.min(
              attemptsLeft,
              2
            )
          )
        )
      );

    try {

      /*
       * Gọi AI
       */
      const quiz =
        provider.type === "groq"
          ? await requestGroq(
              provider,
              prompt,
              timeoutMs
            )
          : await requestGemini(
              provider,
              prompt,
              timeoutMs
            );

      receivedResponse = true;

      /*
       * Làm sạch và chống trùng
       */
      const fresh =
        cleanQuestions(
          quiz.questions,
          allExcluded,
          needed
        );

      questions.push(...fresh);

      /*
       * Ghi note từ AI nếu có.
       */
      if (
        typeof quiz.note ===
          "string" &&
        quiz.note.trim()
      ) {
        note =
          quiz.note.trim();
      }

    } catch (error) {

      /*
       * Không log API key
       * hoặc nội dung tài liệu.
       */
      console.error(
        "Quiz provider failed:",
        {
          provider:
            provider.type,

          model:
            provider.model,

          status:
            error.status || null,

          type:
            error.name
        }
      );
    }
  }

  /*
   * Nếu tất cả provider
   * đều không trả được gì.
   */
  if (
    !questions.length &&
    !receivedResponse
  ) {
    return reply(502, {
      error:
        "Các dịch vụ AI đều chưa tạo được đề. Kiểm tra API key, model và hạn mức rồi thử lại."
    });
  }

  /*
   * Đếm câu vận dụng.
   */
  const applicationCount =
    questions.filter(
      q =>
        q.k === "Vận dụng"
    ).length;

  /*
   * Trả kết quả.
   */
  return reply(200, {

    questions:
      questions.slice(0, count),

    meta: {
      requested: count,

      generated:
        Math.min(
          questions.length,
          count
        ),

      applicationQuestions:
        applicationCount,

      attempts
    },

    note:
      questions.length < count
        ? [
            `Tạo được ${questions.length}/${count} câu mới hợp lệ sau ${attempts} vòng.`,

            note ||
              "Nguồn tài liệu có thể đã gần hết ý mới hoặc dịch vụ AI hết thời gian/hạn mức."
          ].join(" ")
        : ""
  });
};

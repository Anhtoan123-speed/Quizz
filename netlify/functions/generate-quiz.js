const LEVELS = new Set(["Dễ", "Trung bình", "Khó", "Trộn tất cả"]);

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const reply = (statusCode, body) => ({
  statusCode,
  headers,
  body: body === undefined ? "" : JSON.stringify(body)
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Tổng thời gian tối đa cho một lần tạo đề
const TIME_BUDGET_MS = Number(process.env.TIME_BUDGET_MS) || 24000;

// ======================================================
// SCHEMA CÂU HỎI
// ======================================================

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          q: { type: "STRING" },
          o: {
            type: "ARRAY",
            items: { type: "STRING" }
          },
          c: { type: "INTEGER" },
          l: { type: "INTEGER" },
          e: { type: "STRING" }
        },
        required: ["q", "o", "c", "l", "e"]
      }
    },
    note: { type: "STRING" }
  },
  required: ["questions"]
};

// ======================================================
// TẠO PROMPT
// ======================================================

function createPrompt({ text, targetCount, level, subject }) {
  const levelInstruction =
    level === "Trộn tất cả"
      ? "Phân bố hợp lý giữa mức Dễ, Trung bình và Khó."
      : `Toàn bộ câu hỏi ở mức ${level}.`;

  return `Bạn là giáo viên soạn đề trắc nghiệm ôn tập bằng tiếng Việt.

Dựa CHỈ vào tài liệu bên dưới, thuộc chủ đề "${subject || "Chưa xác định"}".

Hãy tạo CHÍNH XÁC ${targetCount} câu hỏi trắc nghiệm khác nhau.
Không được tạo ít hơn ${targetCount} câu.

Yêu cầu bắt buộc:
- Mỗi câu có đúng 4 đáp án và chỉ 1 đáp án đúng.
- Câu hỏi kiểm tra sự hiểu nội dung: khái niệm, chức năng, phân biệt, tình huống áp dụng, nguyên nhân-kết quả hoặc chọn phát biểu đúng nhất.
- TUYỆT ĐỐI không tạo câu điền từ vào chỗ trống.
- Không tạo câu trùng ý, mơ hồ hoặc đáp án sai ngẫu nhiên.
- Ba đáp án nhiễu phải hợp lý và cùng chủ đề.
- Mỗi lời giải gồm đúng 2 câu ngắn gọn, giải thích rõ vì sao đáp án đúng.
- ${levelInstruction}

Trả về JSON hợp lệ theo cấu trúc:

{
  "questions":[
    {
      "q":"Nội dung câu hỏi",
      "o":["Đáp án A","Đáp án B","Đáp án C","Đáp án D"],
      "c":0,
      "l":1,
      "e":"Lời giải gồm 2 câu."
    }
  ],
  "note":""
}

Trong đó:
- c là chỉ số đáp án đúng từ 0 đến 3.
- l là 1 (Dễ), 2 (Trung bình) hoặc 3 (Khó).

CHỈ trả JSON.
Không thêm markdown.
Không thêm \`\`\`json.
Không viết nội dung bên ngoài JSON.

TÀI LIỆU:
${text}`;
}

// ======================================================
// XỬ LÝ JSON
// ======================================================

function cleanJson(text) {
  return text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
}

// ======================================================
// KIỂM TRA CÂU HỎI
// ======================================================

function validQuestion(question) {
  if (
    !question ||
    typeof question.q !== "string" ||
    !question.q.trim()
  ) {
    return false;
  }

  if (!Array.isArray(question.o) || question.o.length !== 4) {
    return false;
  }

  if (
    !question.o.every(
      (item) => typeof item === "string" && item.trim()
    )
  ) {
    return false;
  }

  if (
    new Set(
      question.o.map((item) =>
        item.trim().toLowerCase()
      )
    ).size !== 4
  ) {
    return false;
  }

  if (
    !Number.isInteger(question.c) ||
    question.c < 0 ||
    question.c > 3
  ) {
    return false;
  }

  if (
    typeof question.e !== "string" ||
    question.e.trim().length < 40
  ) {
    return false;
  }

  if (/điền từ|chỗ trống|_{3,}/i.test(question.q)) {
    return false;
  }

  return true;
}

function normalizeQuestion(question) {
  return {
    q: question.q.trim(),
    o: question.o.map((item) => item.trim()),
    c: question.c,
    l: [1, 2, 3].includes(question.l)
      ? question.l
      : 2,
    e: question.e.trim()
  };
}

function dedupe(questions) {
  const seen = new Set();

  return questions.filter((item) => {
    const key = item.q
      .toLowerCase()
      .replace(/\s+/g, " ");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

// ======================================================
// CÁC LỖI CÓ THỂ THỬ LẠI
// ======================================================

const RETRYABLE = new Set([
  429,
  500,
  502,
  503,
  504
]);

// ======================================================
// GEMINI
// ======================================================

async function callGemini({
  model,
  prompt,
  maxOutputTokens,
  startedAt,
  maxAttempts = 1,
  thinkingLevel
}) {
  let lastError;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    const remaining =
      TIME_BUDGET_MS -
      (Date.now() - startedAt);

    if (remaining < 4000) {
      break;
    }

    const controller =
      new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      remaining
    );

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",

          signal: controller.signal,

          headers: {
            "Content-Type":
              "application/json",

            "x-goog-api-key":
              process.env.GEMINI_API_KEY
          },

          body: JSON.stringify({
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

            generationConfig: {
              responseMimeType:
                "application/json",

              responseSchema:
                RESPONSE_SCHEMA,

              maxOutputTokens,

              ...(thinkingLevel
                ? {
                    thinkingConfig: {
                      thinkingLevel
                    }
                  }
                : {})
            }
          })
        }
      );

      clearTimeout(timer);

      const data =
        await response
          .json()
          .catch(() => ({}));

      if (response.ok) {
        return data;
      }

      lastError = {
        status: response.status,
        provider: "gemini",
        data
      };

      if (
        RETRYABLE.has(response.status) &&
        attempt < maxAttempts
      ) {
        await wait(attempt * 1000);
        continue;
      }

      break;
    } catch (error) {
      clearTimeout(timer);

      if (error.name === "AbortError") {
        lastError = {
          status: 504,
          provider: "gemini",

          data: {
            error: {
              message:
                "Gemini hết thời gian chờ."
            }
          }
        };

        break;
      }

      lastError = {
        status: 0,
        provider: "gemini",

        data: {
          error: {
            message: error.message
          }
        }
      };
    }
  }

  throw (
    lastError || {
      status: 504,
      provider: "gemini",
      data: {}
    }
  );
}

// ======================================================
// GROQ FALLBACK
// ======================================================

async function callGroq({
  prompt,
  maxOutputTokens,
  startedAt,
  maxAttempts = 2
}) {
  const model =
    process.env.GROQ_MODEL ||
    "llama-3.3-70b-versatile";

  let lastError;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    const remaining =
      TIME_BUDGET_MS -
      (Date.now() - startedAt);

    if (remaining < 4000) {
      break;
    }

    const controller =
      new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      remaining
    );

    try {
      const response = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",

          signal: controller.signal,

          headers: {
            "Content-Type":
              "application/json",

            Authorization:
              `Bearer ${process.env.GROQ_API_KEY}`
          },

          body: JSON.stringify({
            model,

            messages: [
              {
                role: "system",

                content:
                  "Bạn là giáo viên soạn đề trắc nghiệm. Chỉ trả về JSON hợp lệ, không sử dụng Markdown."
              },

              {
                role: "user",
                content: prompt
              }
            ],

            response_format: {
              type: "json_object"
            },

            max_completion_tokens:
              Math.min(
                maxOutputTokens,
                8000
              ),

            temperature: 0.2
          })
        }
      );

      clearTimeout(timer);

      const data =
        await response
          .json()
          .catch(() => ({}));

      if (response.ok) {
        const raw =
          data?.choices?.[0]
            ?.message?.content;

        if (!raw) {
          throw {
            status: 502,
            provider: "groq",

            data: {
              error: {
                message:
                  "Groq không trả về nội dung."
              }
            }
          };
        }

        // Chuyển dữ liệu Groq sang cấu trúc
        // giống Gemini để phần code phía dưới
        // xử lý chung.

        return {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: raw
                  }
                ]
              },

              finishReason:
                data?.choices?.[0]
                  ?.finish_reason ===
                "length"
                  ? "MAX_TOKENS"
                  : "STOP"
            }
          ]
        };
      }

      lastError = {
        status: response.status,
        provider: "groq",
        data
      };

      if (
        RETRYABLE.has(response.status) &&
        attempt < maxAttempts
      ) {
        await wait(attempt * 1000);
        continue;
      }

      break;
    } catch (error) {
      clearTimeout(timer);

      if (error?.status) {
        lastError = error;
        break;
      }

      if (error.name === "AbortError") {
        lastError = {
          status: 504,
          provider: "groq",

          data: {
            error: {
              message:
                "Groq hết thời gian chờ."
            }
          }
        };

        break;
      }

      lastError = {
        status: 0,
        provider: "groq",

        data: {
          error: {
            message: error.message
          }
        }
      };

      if (attempt < maxAttempts) {
        await wait(attempt * 1000);
      }
    }
  }

  throw (
    lastError || {
      status: 504,
      provider: "groq",

      data: {
        error: {
          message:
            "Groq hết thời gian chờ."
        }
      }
    }
  );
}

// ======================================================
// THÔNG BÁO LỖI
// ======================================================

function errorReply(error) {
  const status = error?.status;

  const provider =
    error?.provider || "AI";

  const message = String(
    error?.data?.error?.message ||
      error?.data?.message ||
      ""
  );

  if (
    status === 400 &&
    /api key|API_KEY/i.test(message)
  ) {
    return reply(500, {
      error:
        `API key ${provider} không hợp lệ. Hãy kiểm tra Environment Variables trên Netlify.`
    });
  }

  if (
    status === 401 ||
    status === 403
  ) {
    return reply(500, {
      error:
        `API key ${provider} không có quyền hoặc không hợp lệ.`
    });
  }

  if (status === 404) {
    return reply(500, {
      error:
        `Không tìm thấy model ${provider}. Hãy kiểm tra tên model trong Netlify.`
    });
  }

  if (status === 429) {
    return reply(429, {
      error:
        "Dịch vụ AI đã chạm giới hạn tạm thời. Hãy thử lại sau ít phút."
    });
  }

  if (status === 503) {
    return reply(503, {
      error:
        "Dịch vụ AI đang tạm thời quá tải. Hãy thử lại sau ít phút."
    });
  }

  if (status === 504) {
    return reply(504, {
      error:
        "Tạo câu hỏi quá lâu. Hãy giảm số câu hoặc rút ngắn tài liệu rồi thử lại."
    });
  }

  console.error(
    "Chi tiết lỗi AI:",
    JSON.stringify(error)
  );

  return reply(502, {
    error:
      "Không thể tạo câu hỏi từ AI. Hãy thử lại sau."
  });
}

// ======================================================
// NETLIFY FUNCTION
// ======================================================

exports.handler =
  async function handler(event) {

    if (event.httpMethod === "OPTIONS") {
      return reply(204);
    }

    if (event.httpMethod !== "POST") {
      return reply(405, {
        error:
          "Chỉ hỗ trợ phương thức POST."
      });
    }

    const startedAt = Date.now();

    let input;

    try {
      input = JSON.parse(
        event.body || "{}"
      );
    } catch {
      return reply(400, {
        error:
          "Dữ liệu gửi lên không hợp lệ."
      });
    }

    const {
      text,
      count,
      level,
      subject
    } = input;

    const safeCount =
      Math.min(
        Math.max(
          Math.floor(
            Number(count)
          ) || 10,
          1
        ),
        50
      );

    // ==================================================
    // KIỂM TRA INPUT
    // ==================================================

    if (
      typeof text !== "string" ||
      text.trim().length < 100
    ) {
      return reply(400, {
        error:
          "Tài liệu cần có ít nhất 100 ký tự để tạo câu hỏi."
      });
    }

    if (!LEVELS.has(level)) {
      return reply(400, {
        error:
          "Mức độ câu hỏi không hợp lệ."
      });
    }

    if (
      !process.env.GEMINI_API_KEY &&
      !process.env.GROQ_API_KEY
    ) {
      return reply(500, {
        error:
          "Server chưa được cấu hình GEMINI_API_KEY hoặc GROQ_API_KEY."
      });
    }

    // Tạo dư vài câu để sau khi lọc
    // vẫn có đủ số lượng người dùng yêu cầu.

    const targetCount =
      Math.min(
        safeCount +
          (safeCount >= 20 ? 4 : 3),
        50
      );

    const model =
      process.env.GEMINI_MODEL ||
      "gemini-3.5-flash-lite";

    const fallbackEnv =
      process.env
        .GEMINI_FALLBACK_MODEL ||
      "gemini-3.5-flash";

    const fallbackModel =
      fallbackEnv === "none" ||
      fallbackEnv === model
        ? ""
        : fallbackEnv;

    const maxOutputTokens =
      Math.min(
        2000 +
          targetCount * 500,
        30000
      );

    try {
      // ==================================================
      // TẠO PROMPT
      // ==================================================

      const prompt =
        createPrompt({
          text:
            text.slice(0, 12000),

          targetCount,

          level,

          subject
        });

      let data;

      // ==================================================
      // 1. THỬ GEMINI CHÍNH
      // ==================================================

      if (
        process.env.GEMINI_API_KEY
      ) {
        try {
          console.log(
            `Đang thử Gemini: ${model}`
          );

          data =
            await callGemini({
              model,

              prompt,

              maxOutputTokens,

              startedAt,

              // Chỉ thử 1 lần để không tốn
              // quá nhiều quota trước khi
              // chuyển sang Groq.
              maxAttempts: 1
            });

          console.log(
            `Tạo quiz thành công bằng Gemini: ${model}`
          );
        } catch (
          primaryError
        ) {
          console.warn(
            `Gemini ${model} lỗi ${primaryError?.status}`
          );

          let geminiError =
            primaryError;

          // ==============================================
          // 2. GEMINI FALLBACK
          // ==============================================

          const canTryFallback =
            fallbackModel &&
            RETRYABLE.has(
              primaryError?.status
            ) &&
            TIME_BUDGET_MS -
              (Date.now() -
                startedAt) >
              9000;

          if (canTryFallback) {
            try {
              console.warn(
                `Chuyển sang Gemini fallback: ${fallbackModel}`
              );

              data =
                await callGemini({
                  model:
                    fallbackModel,

                  prompt,

                  maxOutputTokens,

                  startedAt,

                  maxAttempts: 1,

                  thinkingLevel:
                    process.env
                      .GEMINI_FALLBACK_THINKING ||
                    "low"
                });

              console.log(
                `Tạo quiz thành công bằng Gemini fallback: ${fallbackModel}`
              );
            } catch (
              fallbackError
            ) {
              geminiError =
                fallbackError;

              console.warn(
                `Gemini fallback lỗi ${fallbackError?.status}`
              );
            }
          }

          // ==============================================
          // 3. GROQ FALLBACK
          // ==============================================

          if (!data) {
            const canUseGroq =
              process.env
                .GROQ_API_KEY &&
              TIME_BUDGET_MS -
                (Date.now() -
                  startedAt) >
                4000;

            if (!canUseGroq) {
              throw geminiError;
            }

            console.warn(
              "Gemini không khả dụng. Chuyển sang Groq..."
            );

            data =
              await callGroq({
                prompt,

                maxOutputTokens,

                startedAt,

                maxAttempts: 2
              });

            console.log(
              `Tạo quiz thành công bằng Groq: ${
                process.env
                  .GROQ_MODEL ||
                "llama-3.3-70b-versatile"
              }`
            );
          }
        }
      } else {
        // Không có Gemini key
        // thì chạy Groq trực tiếp.

        console.log(
          "Không có Gemini key. Dùng Groq."
        );

        data =
          await callGroq({
            prompt,

            maxOutputTokens,

            startedAt,

            maxAttempts: 2
          });
      }

      // ==================================================
      // KIỂM TRA KẾT QUẢ
      // ==================================================

      if (
        data.promptFeedback
          ?.blockReason
      ) {
        return reply(422, {
          error:
            "AI từ chối xử lý tài liệu này. Hãy thử với nội dung khác."
        });
      }

      const candidate =
        data.candidates?.[0];

      if (
        candidate?.finishReason ===
        "MAX_TOKENS"
      ) {
        return reply(502, {
          error:
            "Câu trả lời bị cắt do quá dài. Hãy giảm số câu rồi thử lại."
        });
      }

      const raw =
        candidate?.content?.parts
          ?.map(
            (part) =>
              part.text || ""
          )
          .join("")
          .trim();

      if (!raw) {
        return reply(502, {
          error:
            "AI không trả về nội dung câu hỏi. Hãy thử lại."
        });
      }

      // ==================================================
      // PARSE JSON
      // ==================================================

      let quiz;

      try {
        quiz =
          JSON.parse(
            cleanJson(raw)
          );
      } catch (error) {
        console.error(
          "JSON AI không hợp lệ:",
          raw.slice(0, 500)
        );

        return reply(502, {
          error:
            "AI trả về dữ liệu sai định dạng. Hãy thử lại."
        });
      }

      // ==================================================
      // LỌC CÂU HỎI
      // ==================================================

      const questions =
        dedupe(
          (
            Array.isArray(
              quiz.questions
            )
              ? quiz.questions
              : []
          )
            .filter(
              validQuestion
            )
            .map(
              normalizeQuestion
            )
        ).slice(
          0,
          safeCount
        );

      // ==================================================
      // PHẢI ĐỦ SỐ CÂU
      // ==================================================

      if (
        questions.length <
        safeCount
      ) {
        return reply(502, {
          error:
            `AI chỉ tạo được ${questions.length}/${safeCount} câu hợp lệ. Hãy thử lại hoặc bổ sung tài liệu chi tiết hơn.`
        });
      }

      console.log(
        `Hoàn thành ${questions.length}/${safeCount} câu hỏi.`
      );

      // ==================================================
      // THÀNH CÔNG
      // ==================================================

      return reply(200, {
        questions,

        note:
          typeof quiz.note ===
          "string"
            ? quiz.note
            : ""
      });
    } catch (error) {
      console.error(
        "AI API error:",
        JSON.stringify(error)
      );

      return errorReply(error);
    }
  };

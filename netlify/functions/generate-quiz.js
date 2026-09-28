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
  body: JSON.stringify(body)
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
- Mỗi lời giải phải có ít nhất 2 câu, giải thích rõ vì sao đáp án đúng.
- ${levelInstruction}

Trả về JSON hợp lệ, không kèm Markdown hay lời dẫn:

{
  "questions": [
    {
      "q": "Nội dung câu hỏi",
      "o": ["Đáp án A", "Đáp án B", "Đáp án C", "Đáp án D"],
      "c": 0,
      "l": 1,
      "e": "Lời giải chi tiết gồm ít nhất 2 câu."
    }
  ],
  "note": ""
}

Trong đó:
- c là chỉ số đáp án đúng từ 0 đến 3.
- l là 1 (Dễ), 2 (Trung bình) hoặc 3 (Khó).

TÀI LIỆU:
${text}`;
}

function cleanJson(text) {
  return text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
}

function validQuestion(question) {
  if (!question || typeof question.q !== "string") return false;
  if (!Array.isArray(question.o) || question.o.length !== 4) return false;
  if (!question.o.every((item) => typeof item === "string" && item.trim())) return false;
  if (new Set(question.o.map((item) => item.trim().toLowerCase())).size !== 4) return false;
  if (!Number.isInteger(question.c) || question.c < 0 || question.c > 3) return false;
  if (typeof question.e !== "string" || question.e.trim().length < 40) return false;
  if (/điền từ|chỗ trống|_{3,}/i.test(question.q)) return false;
  return true;
}

async function callGemini(model, prompt) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.3
          }
        })
      }
    );

    const data = await response.json();

    if (response.ok) return data;

    lastError = { status: response.status, data };

    // Gemini quá tải: chờ rồi tự thử lại
    if (response.status === 503 && attempt < 3) {
      await wait(attempt * 2000);
      continue;
    }

    break;
  }

  throw lastError;
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") return reply(204, {});
  if (event.httpMethod !== "POST") {
    return reply(405, { error: "Chỉ hỗ trợ phương thức POST." });
  }

  let input;

  try {
    input = JSON.parse(event.body || "{}");
  } catch {
    return reply(400, { error: "Dữ liệu gửi lên không hợp lệ." });
  }

  const { text, count, level, subject } = input;
  const safeCount = Math.min(Math.max(Number(count) || 10, 1), 50);

  if (typeof text !== "string" || text.trim().length < 100) {
    return reply(400, {
      error: "Tài liệu cần có ít nhất 100 ký tự để tạo câu hỏi."
    });
  }

  if (!LEVELS.has(level)) {
    return reply(400, { error: "Mức độ câu hỏi không hợp lệ." });
  }

  if (!process.env.GEMINI_API_KEY) {
    return reply(500, {
      error: "Server chưa được cấu hình GEMINI_API_KEY."
    });
  }

  // Chọn 10 câu thì yêu cầu AI tạo 15 câu, sau đó web lấy 10 câu hợp lệ.
  const targetCount = safeCount >= 46 ? 50 : safeCount + 5;
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

  try {
    const providerData = await callGemini(
      model,
      createPrompt({
        text: text.slice(0, 12000),
        targetCount,
        level,
        subject
      })
    );

    const raw = providerData.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();

    if (!raw) {
      return reply(502, { error: "AI không trả về nội dung câu hỏi." });
    }

    const quiz = JSON.parse(cleanJson(raw));

    const questions = (Array.isArray(quiz.questions) ? quiz.questions : [])
      .filter(validQuestion);

    if (questions.length < safeCount) {
      return reply(502, {
        error: `AI chỉ tạo được ${questions.length} câu hợp lệ. Hãy thử lại hoặc bổ sung tài liệu chi tiết hơn.`
      });
    }

    return reply(200, {
      questions,
      note: typeof quiz.note === "string" ? quiz.note : ""
    });
  } catch (error) {
    console.error("Gemini API error:", error);

    if (error?.status === 503) {
      return reply(503, {
        error: "Gemini đang quá tải sau 3 lần thử tự động. Hãy thử lại sau ít phút."
      });
    }

    if (error?.status === 429) {
      return reply(429, {
        error: "Bạn đã dùng hết giới hạn Gemini tạm thời. Hãy thử lại sau."
      });
    }

    return reply(502, {
      error: "Không thể tạo câu hỏi từ Gemini. Hãy kiểm tra lại API key hoặc thử lại sau."
    });
  }
};

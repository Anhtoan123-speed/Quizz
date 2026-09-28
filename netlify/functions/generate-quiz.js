/*
  Netlify Function: POST /.netlify/functions/generate-quiz
  Thêm GEMINI_API_KEY trong Netlify → Site configuration → Environment variables.
*/

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

function createPrompt({ text, count, level, subject }) {
  const levelInstruction = level === "Trộn tất cả"
    ? "Phân bố hợp lý giữa Dễ, Trung bình và Khó."
    : `Toàn bộ câu hỏi ở mức ${level}.`;

  return `Bạn là giáo viên soạn đề trắc nghiệm ôn tập bằng tiếng Việt.

Dựa CHỈ vào tài liệu bên dưới, thuộc chủ đề "${subject || "Chưa xác định"}", hãy tạo tối đa ${count} câu hỏi trắc nghiệm chất lượng.

Yêu cầu bắt buộc:
- Mỗi câu có đúng 4 đáp án và chỉ 1 đáp án đúng.
- Câu hỏi phải kiểm tra sự hiểu nội dung: khái niệm, chức năng, phân biệt, tình huống áp dụng, nguyên nhân-kết quả hoặc chọn phát biểu đúng nhất.
- TUYỆT ĐỐI không tạo câu điền từ vào chỗ trống, không che từ trong đoạn văn và không dùng đáp án sai ngẫu nhiên.
- Ba đáp án nhiễu phải hợp lý, cùng chủ đề nhưng sai về kiến thức.
- Không tạo câu mơ hồ, trùng ý hoặc dùng thông tin không có trong tài liệu.
- Mỗi lời giải phải giải thích rõ vì sao đáp án đúng; khi phù hợp, nói ngắn vì sao các đáp án còn lại sai.
- ${levelInstruction}

Trả về JSON hợp lệ theo đúng cấu trúc này, không kèm Markdown hay lời dẫn:
{
  "questions": [
    {
      "q": "Nội dung câu hỏi",
      "o": ["Đáp án A", "Đáp án B", "Đáp án C", "Đáp án D"],
      "c": 0,
      "l": 1,
      "e": "Lời giải chi tiết"
    }
  ],
  "note": ""
}

Trong đó c là chỉ số đáp án đúng từ 0 đến 3; l là 1 (Dễ), 2 (Trung bình) hoặc 3 (Khó).

TÀI LIỆU:
${text}`;
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") return reply(204, {});
  if (event.httpMethod !== "POST") return reply(405, { error: "Chỉ hỗ trợ phương thức POST." });

  let input;
  try {
    input = JSON.parse(event.body || "{}");
  } catch {
    return reply(400, { error: "Dữ liệu gửi lên không hợp lệ." });
  }

  const { text, count, level, subject } = input;
  const safeCount = Math.min(Math.max(Number(count) || 10, 1), 50);

  if (typeof text !== "string" || text.trim().length < 100) {
    return reply(400, { error: "Tài liệu cần có ít nhất 100 ký tự để tạo câu hỏi." });
  }
  if (!LEVELS.has(level)) return reply(400, { error: "Mức độ câu hỏi không hợp lệ." });
  if (!process.env.GEMINI_API_KEY) return reply(500, { error: "Server chưa được cấu hình GEMINI_API_KEY." });

  try {
    const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: createPrompt({ text: text.slice(0, 12000), count: safeCount, level, subject }) }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.35 }
        })
      }
    );

    const providerData = await response.json();
    if (!response.ok) {
      console.error("Gemini API error:", providerData);
      return reply(502, { error: "AI không thể tạo câu hỏi. Hãy thử lại sau." });
    }

    const raw = providerData.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();
    if (!raw) return reply(502, { error: "AI không trả về nội dung câu hỏi." });

    const quiz = JSON.parse(raw);
    return reply(200, {
      questions: Array.isArray(quiz.questions) ? quiz.questions : [],
      note: typeof quiz.note === "string" ? quiz.note : ""
    });
  } catch (error) {
    console.error("generate-quiz error:", error);
    return reply(500, { error: "Có lỗi khi xử lý câu hỏi AI. Hãy thử lại." });
  }
};

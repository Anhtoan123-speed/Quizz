/*
 * netlify/functions/generate-quiz.js
 *
 * ENV:
 * GEMINI_API_KEY
 * GEMINI_MODEL
 * GEMINI_FALLBACK_MODEL
 * GEMINI_FALLBACK_THINKING
 * GROQ_API_KEY
 * GROQ_MODEL
 */

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


/* =========================================================
   NORMALIZE
========================================================= */

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


/* =========================================================
   STOP WORDS
========================================================= */

const STOP_WORDS = new Set([
  // Vietnamese
  "la", "gi", "nao", "sau", "day",
  "trong", "cac", "mot", "nhung",
  "va", "voi", "cua", "cho", "khi",
  "theo", "duoc", "ve", "co",
  "khong", "dung", "nhat", "hay",
  "phat", "bieu", "lua", "chon",
  "dap", "an", "noi", "hoi",
  "truong", "hop", "khai", "niem",

  // English
  "the", "is", "are", "was", "were",
  "and", "or", "of", "to", "in",
  "for", "with", "that", "this",
  "from", "as", "by", "on", "an",
  "a", "be", "can", "will", "what",
  "which", "how", "when", "where",
  "following", "statement", "statements",
  "correct", "incorrect", "best",
  "question", "about", "according",
  "concept", "option", "choice"
]);

function semanticWords(text) {
  return normalize(text)
    .split(" ")
    .filter(
      word =>
        word.length > 2 &&
        !STOP_WORDS.has(word)
    );
}

function tokenSet(text) {
  return new Set(
    semanticWords(text)
  );
}

function bigrams(text) {
  const words =
    semanticWords(text);

  const result = new Set();

  for (
    let i = 0;
    i < words.length - 1;
    i++
  ) {
    result.add(
      words[i] +
      " " +
      words[i + 1]
    );
  }

  return result;
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

  return (
    common /
    (
      a.size +
      b.size -
      common
    )
  );
}


/* =========================================================
   CHỐNG TRÙNG
========================================================= */

function isSimilar(a, b) {
  const first =
    normalize(a);

  const second =
    normalize(b);

  if (
    !first ||
    !second
  ) {
    return false;
  }

  if (
    first === second
  ) {
    return true;
  }

  /*
   * Một câu gần như
   * chứa toàn bộ câu kia
   */
  if (
    first.length >= 40 &&
    second.length >= 40
  ) {
    const shorter =
      first.length <
      second.length
        ? first
        : second;

    const longer =
      first.length <
      second.length
        ? second
        : first;

    if (
      longer.includes(
        shorter
      ) &&

      shorter.length /
      longer.length >=
      0.80
    ) {
      return true;
    }
  }

  const wordScore =
    jaccard(
      tokenSet(first),
      tokenSet(second)
    );

  const bigramScore =
    jaccard(
      bigrams(first),
      bigrams(second)
    );

  /*
   * Ngưỡng cao để tránh
   * loại nhầm những câu
   * cùng cấu trúc nhưng
   * hỏi kiến thức khác.
   */
  return (
    wordScore >= 0.84 ||

    bigramScore >= 0.80 ||

    (
      wordScore >= 0.78 &&
      bigramScore >= 0.65
    )
  );
}


/* =========================================================
   VALIDATE QUESTION
========================================================= */

function validQuestion(q) {
  return (
    q &&

    typeof q.q ===
      "string" &&

    q.q.trim().length >=
      8 &&

    /*
     * Không điền từ
     * cả tiếng Việt và tiếng Anh.
     */
    !/điền từ|chỗ trống|fill in the blank|fill the blank|_{3,}/i
      .test(q.q) &&

    Array.isArray(q.o) &&

    q.o.length === 4 &&

    q.o.every(
      option =>
        typeof option ===
          "string" &&
        option.trim()
    ) &&

    /*
     * 4 đáp án phải khác nhau.
     */
    new Set(
      q.o.map(
        normalize
      )
    ).size === 4 &&

    Number.isInteger(
      q.c
    ) &&

    q.c >= 0 &&

    q.c <= 3 &&

    typeof q.e ===
      "string" &&

    q.e.trim().length >=
      20
  );
}


/* =========================================================
   NORMALIZE LEVEL
========================================================= */

function normalizeLevel(value) {
  if (
    [1, 2, 3].includes(
      value
    )
  ) {
    return value;
  }

  const levels = {
    "Dễ": 1,
    "Trung bình": 2,
    "Khó": 3,

    /*
     * Hỗ trợ nếu AI
     * vô tình trả tiếng Anh.
     */
    "Easy": 1,
    "Medium": 2,
    "Hard": 3
  };

  return (
    levels[value] ||
    2
  );
}


/* =========================================================
   NORMALIZE KIND
========================================================= */

function normalizeKind(value) {
  const text =
    normalize(value);

  if (
    text.includes(
      "van dung"
    ) ||

    text.includes(
      "tinh huong"
    ) ||

    text.includes(
      "ap dung"
    ) ||

    text.includes(
      "application"
    ) ||

    text.includes(
      "scenario"
    )
  ) {
    return "Vận dụng";
  }

  return "Kiến thức";
}


/* =========================================================
   CLEAN QUESTIONS
========================================================= */

function cleanQuestions(
  list,
  exclude,
  limit,
  quizMode = "apply"
) {
  const seen = [
    ...exclude
  ];

  const output = [];

  for (
    const q of
    Array.isArray(list)
      ? list
      : []
  ) {
    if (
      !validQuestion(q)
    ) {
      continue;
    }

    /*
     * Loại câu trùng.
     */
    if (
      seen.some(
        old =>
          isSimilar(
            old,
            q.q
          )
      )
    ) {
      continue;
    }

    const question = {
      q:
        q.q.trim(),

      o:
        q.o.map(
          option =>
            option.trim()
        ),

      c:
        q.c,

      l:
        normalizeLevel(
          q.l
        ),

      e:
        q.e.trim(),

      t:
        typeof q.t ===
          "string"
          ? q.t.trim()
          : "",

      k:
        normalizeKind(
          q.k
        )
    };

    /*
     * SOURCE MODE:
     *
     * Không chấp nhận
     * câu Vận dụng.
     */
    if (
      quizMode ===
        "source" &&

      question.k ===
        "Vận dụng"
    ) {
      continue;
    }

    output.push(
      question
    );

    seen.push(
      question.q
    );

    if (
      output.length >=
      limit
    ) {
      break;
    }
  }

  return output;
}


/* =========================================================
   EXCLUDE
========================================================= */

function compactExclude(
  exclude,
  maxItems = 220,
  maxChars = 60000
) {
  const source =
    Array.isArray(exclude)
      ? exclude.slice(
          -maxItems
        )
      : [];

  const output = [];

  let chars = 0;

  for (
    let i =
      source.length - 1;

    i >= 0;

    i--
  ) {
    const item =
      String(
        source[i] ||
        ""
      ).slice(
        0,
        700
      );

    if (!item) {
      continue;
    }

    if (
      chars +
      item.length >
      maxChars
    ) {
      break;
    }

    output.push(
      item
    );

    chars +=
      item.length;
  }

  return output.reverse();
}


/* =========================================================
   DIFFICULTY PLAN
========================================================= */

function getDifficultyPlan(
  count,
  level
) {
  /*
   * Nếu người dùng chọn
   * riêng một độ khó.
   */
  if (
    level !==
    "Trộn tất cả"
  ) {
    return {
      easy:
        level === "Dễ"
          ? count
          : 0,

      medium:
        level ===
          "Trung bình"
          ? count
          : 0,

      hard:
        level === "Khó"
          ? count
          : 0
    };
  }

  /*
   * Chia gần đều.
   */
  const base =
    Math.floor(
      count / 3
    );

  const remain =
    count % 3;

  let easy =
    base;

  let medium =
    base;

  let hard =
    base;

  /*
   * Ví dụ 10 câu:
   *
   * Dễ: 3
   * Trung bình: 4
   * Khó: 3
   */
  if (
    remain >= 1
  ) {
    medium++;
  }

  if (
    remain >= 2
  ) {
    hard++;
  }

  return {
    easy,
    medium,
    hard
  };
}


/* =========================================================
   COUNT LEVELS
========================================================= */

function countLevels(
  questions
) {
  return {
    easy:
      questions.filter(
        q =>
          q.l === 1
      ).length,

    medium:
      questions.filter(
        q =>
          q.l === 2
      ).length,

    hard:
      questions.filter(
        q =>
          q.l === 3
      ).length
  };
}


/* =========================================================
   APPLICATION TARGET
========================================================= */

function targetAppCount(
  count,
  quizMode = "apply"
) {
  /*
   * SOURCE:
   * 0% vận dụng.
   */
  if (
    quizMode ===
    "source"
  ) {
    return 0;
  }

  /*
   * APPLY:
   * khoảng 20%.
   */
  return Math.max(
    1,
    Math.round(
      count * 0.20
    )
  );
}


/* =========================================================
   CHECK ENOUGH QUESTIONS
========================================================= */

function enoughForTarget(
  questions,
  count,
  level
) {
  /*
   * Chọn riêng
   * Dễ / Trung bình / Khó.
   */
  if (
    level !==
    "Trộn tất cả"
  ) {
    const targetLevel =
      normalizeLevel(
        level
      );

    return (
      questions.filter(
        q =>
          q.l ===
          targetLevel
      ).length >=
      count
    );
  }

  /*
   * Trộn tất cả:
   * phải đủ từng nhóm.
   */
  const plan =
    getDifficultyPlan(
      count,
      level
    );

  const current =
    countLevels(
      questions
    );

  return (
    current.easy >=
      plan.easy &&

    current.medium >=
      plan.medium &&

    current.hard >=
      plan.hard
  );
}


/* =========================================================
   SELECT BALANCED QUESTIONS
========================================================= */

function selectBalancedQuestions(
  questions,
  count,
  level
) {
  /*
   * Chọn riêng
   * một mức.
   */
  if (
    level !==
    "Trộn tất cả"
  ) {
    const target =
      normalizeLevel(
        level
      );

    return questions
      .filter(
        q =>
          q.l ===
          target
      )
      .slice(
        0,
        count
      );
  }

  /*
   * Trộn.
   */
  const plan =
    getDifficultyPlan(
      count,
      level
    );

  const easy =
    questions.filter(
      q =>
        q.l === 1
    );

  const medium =
    questions.filter(
      q =>
        q.l === 2
    );

  const hard =
    questions.filter(
      q =>
        q.l === 3
    );

  return [
    ...easy.slice(
      0,
      plan.easy
    ),

    ...medium.slice(
      0,
      plan.medium
    ),

    ...hard.slice(
      0,
      plan.hard
    )
  ].slice(
    0,
    count
  );
}


/* =========================================================
   REBALANCE APPLICATION
========================================================= */

function rebalanceApplication(
  finalQuestions,
  pool,
  count,
  quizMode = "apply"
) {
  /*
   * Chỉ bám sát tài liệu:
   * không giữ Vận dụng.
   */
  if (
    quizMode ===
    "source"
  ) {
    return finalQuestions.filter(
      q =>
        q.k !==
        "Vận dụng"
    );
  }

  const target =
    targetAppCount(
      count,
      quizMode
    );

  /*
   * Cho phép dư nhẹ
   * nhưng không quá khoảng 25%.
   */
  const maxApplication =
    Math.max(
      target,

      Math.ceil(
        count * 0.25
      )
    );

  let appCount =
    finalQuestions.filter(
      q =>
        q.k ===
        "Vận dụng"
    ).length;

  if (
    appCount <=
    maxApplication
  ) {
    return finalQuestions;
  }

  const used =
    new Set(
      finalQuestions.map(
        q =>
          normalize(q.q)
      )
    );

  /*
   * Chỉ thay bằng câu
   * kiến thức cùng mức độ
   * để không phá tỷ lệ độ khó.
   */
  const knowledgeByLevel = {
    1:
      pool.filter(
        q =>
          q.k !==
            "Vận dụng" &&

          q.l === 1 &&

          !used.has(
            normalize(
              q.q
            )
          )
      ),

    2:
      pool.filter(
        q =>
          q.k !==
            "Vận dụng" &&

          q.l === 2 &&

          !used.has(
            normalize(
              q.q
            )
          )
      ),

    3:
      pool.filter(
        q =>
          q.k !==
            "Vận dụng" &&

          q.l === 3 &&

          !used.has(
            normalize(
              q.q
            )
          )
      )
  };

  const output = [
    ...finalQuestions
  ];

  for (
    let i =
      output.length - 1;

    i >= 0 &&
    appCount >
      maxApplication;

    i--
  ) {
    if (
      output[i].k !==
      "Vận dụng"
    ) {
      continue;
    }

    const replacement =
      knowledgeByLevel[
        output[i].l
      ].shift();

    if (
      !replacement
    ) {
      continue;
    }

    output[i] =
      replacement;

    appCount--;
  }

  return output;
}


/* =========================================================
   LANGUAGE DETECTION
========================================================= */

function detectLanguage(text) {
  const sample =
    String(
      text || ""
    ).slice(
      0,
      8000
    );

  /*
   * Ký tự đặc trưng
   * tiếng Việt.
   */
  const vietnameseChars = (
    sample.match(
      /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/gi
    ) || []
  ).length;

  /*
   * Từ thông dụng
   * tiếng Việt.
   */
  const vietnameseWords = (
    sample.match(
      /\b(là|của|và|trong|được|không|có|một|những|các|với|cho|khi|theo|này|đó|từ|để|về|như|nên|phải)\b/gi
    ) || []
  ).length;

  /*
   * Từ thông dụng
   * tiếng Anh.
   */
  const englishWords = (
    sample.match(
      /\b(the|is|are|was|were|and|of|to|in|for|with|that|this|from|as|by|on|an|a|or|be|can|will|which|what|how|when|where)\b/gi
    ) || []
  ).length;

  /*
   * Tiếng Việt.
   */
  if (
    vietnameseChars >= 3 ||

    (
      vietnameseWords >= 3 &&
      vietnameseWords >
      englishWords
    )
  ) {
    return "vi";
  }

  /*
   * Tiếng Anh.
   */
  if (
    englishWords >= 3
  ) {
    return "en";
  }

  /*
   * Không xác định rõ:
   * giữ nguyên ngôn ngữ nguồn.
   */
  return "same";
}


/* =========================================================
   LANGUAGE INSTRUCTION
========================================================= */

function getLanguageInstruction(
  text
) {
  const language =
    detectLanguage(
      text
    );

  if (
    language === "vi"
  ) {
    return {
      code:
        "vi",

      name:
        "Vietnamese",

      instruction:
        "Toàn bộ nội dung tự nhiên trong q, o, e và t phải viết bằng tiếng Việt. Không dịch sang tiếng Anh."
    };
  }

  if (
    language === "en"
  ) {
    return {
      code:
        "en",

      name:
        "English",

      instruction:
        "ALL natural-language content in q, o, e and t MUST be written in English. Do not translate the quiz into Vietnamese."
    };
  }

  return {
    code:
      "same",

    name:
      "same language as source",

    instruction:
      "Use the same language as the source material for ALL natural-language content in q, o, e and t. Do not translate it to another language."
  };
}


/* =========================================================
   CREATE PROMPT
========================================================= */

function createPrompt({
  text,
  count,
  totalCount,
  level,
  subject,
  exclude,
  round,
  applicationNeeded,
  difficultyNeeded,
  quizMode = "apply"
}) {
  /*
   * Xin dư câu
   * để backend còn lọc.
   */
  const askCount =
    Math.min(
      70,

      Math.max(
        count + 4,

        Math.ceil(
          count * 1.35
        )
      )
    );

  const promptExclude =
    compactExclude(
      exclude
    );

  const languageInfo =
    getLanguageInstruction(
      text
    );

  let difficultyText;

  /*
   * Hướng dẫn độ khó.
   */
  if (
    level ===
    "Trộn tất cả"
  ) {
    difficultyText = `
Trong toàn bộ đề,
Dễ / Trung bình / Khó
phải gần cân bằng.

Hiện hệ thống còn thiếu khoảng:

- ${Math.max(
      0,
      difficultyNeeded.easy
    )} câu Dễ.

- ${Math.max(
      0,
      difficultyNeeded.medium
    )} câu Trung bình.

- ${Math.max(
      0,
      difficultyNeeded.hard
    )} câu Khó.

Hãy ưu tiên tạo
những mức đang thiếu trước.

Không dồn phần lớn câu
vào cùng một mức độ.
`;

  } else {
    difficultyText = `
Tất cả câu hỏi
ở vòng này
phải ở mức:

${level}
`;
  }

  /*
   * 2 chế độ câu hỏi.
   */
  const questionModeText =
    quizMode === "source"

      ? `
==================================================
CHẾ ĐỘ: CHỈ BÁM SÁT TÀI LIỆU
==================================================

- 100% câu hỏi phải có căn cứ trực tiếp trong tài liệu.

- Không tạo câu Vận dụng.

- Không tạo tình huống mới ngoài tài liệu.

- Không tự thêm bối cảnh, ví dụ hoặc trường hợp thực tế
  mà tài liệu không cung cấp.

- Không yêu cầu người học áp dụng kiến thức
  vào một trường hợp mới.

- Không suy diễn vượt quá nội dung tài liệu.

- Mỗi đáp án đúng phải có thể kiểm chứng
  trực tiếp từ nội dung nguồn.

Các dạng câu nên dùng:

- Khái niệm
- Đặc điểm
- Chức năng
- Mục đích
- Vai trò
- Phân biệt
- Nguyên nhân - kết quả
- Chọn phát biểu đúng
- Chọn phát biểu đúng nhất
- Nhận diện nội dung
- Điều kiện
- Trình tự / quy trình
- Suy luận trực tiếp từ nội dung đã nêu

Tất cả câu phải ghi:

"k": "Kiến thức"
`

      : `
==================================================
CHẾ ĐỘ: CÓ VẬN DỤNG
==================================================

Mục tiêu toàn bộ đề:

- Khoảng 80% câu Kiến thức.
- Khoảng 20% câu Vận dụng / Tình huống.

Hiện hệ thống còn thiếu khoảng:

${applicationNeeded}

câu Vận dụng
để đạt tỷ lệ mục tiêu.

Không tạo quá nhiều câu vận dụng.

Không biến phần lớn đề
thành câu hỏi tình huống.

Câu vận dụng có thể:

- Đưa kiến thức vào tình huống mới.
- Yêu cầu chọn cách xử lý phù hợp.
- Yêu cầu suy luận kết quả.
- Yêu cầu áp dụng kiến thức đã học
  vào trường hợp cụ thể.

Kiến thức dùng để trả lời
vẫn phải xuất phát từ tài liệu.

Không tạo câu vận dụng giả
chỉ bằng cách thêm tên người hoặc công ty
rồi phía sau vẫn hỏi lại định nghĩa.
`;

  return `
You are an expert teacher who creates high-quality multiple-choice quizzes.

==================================================
OUTPUT LANGUAGE / NGÔN NGỮ ĐẦU RA
==================================================

${languageInfo.instruction}

IMPORTANT:

- The source material determines the quiz language.

- English source
  → English questions,
  choices,
  explanations
  and topic labels.

- Vietnamese source
  → Vietnamese questions,
  choices,
  explanations
  and topic labels.

- Do not translate the source
  into another language.

- If the source uses another language,
  preserve that language.

- JSON field names
  and the internal values
  "Kiến thức" / "Vận dụng"
  must remain exactly as specified
  because the application uses them internally.


==================================================
NHIỆM VỤ
==================================================

Đây là vòng tạo câu hỏi số ${round}.

Dựa CHỈ vào tài liệu bên dưới,
hãy tạo khoảng ${askCount} câu hỏi MỚI.

Hệ thống đang cần thêm ${count} câu
để hoàn thành bộ đề ${totalCount} câu.

Chủ đề:

"${subject || "Chưa xác định"}"


==================================================
YÊU CẦU BẮT BUỘC
==================================================

- Mỗi câu có đúng 4 đáp án.

- Chỉ có 1 đáp án đúng.

- Không tạo câu điền từ.

- Không tạo câu chỗ trống.

- Không dùng dấu ___
  để che nội dung.

- Không dùng kiến thức
  ngoài tài liệu.

- Không tự bịa kiến thức
  để đủ câu.

- Không tạo hai câu
  kiểm tra cùng một ý
  rồi chỉ thay đổi cách diễn đạt.

- Không chỉ đổi tên người
  hoặc tên công ty
  rồi xem là câu mới.

- Không chỉ đảo thứ tự đáp án.

- Đáp án nhiễu phải hợp lý.

- Các lựa chọn phải
  cùng phạm vi kiến thức.

- Lời giải phải
  ít nhất 20 ký tự.

- Lời giải phải giải thích
  vì sao đáp án đúng.


==================================================
ĐA DẠNG KIỂU CÂU HỎI
==================================================

Hãy kết hợp nhiều dạng câu.

KHÔNG chỉ tạo
câu hỏi định nghĩa.

Các dạng được phép
và nên sử dụng:

1. Khái niệm.

2. Đặc điểm.

3. Chức năng.

4. Mục đích.

5. Vai trò.

6. Phân biệt hai khái niệm.

7. Nguyên nhân - kết quả.

8. Chọn phát biểu đúng.

9. Chọn phát biểu đúng nhất.

10. Nhận diện trường hợp.

11. Mối quan hệ
giữa các khái niệm.

12. Điều kiện áp dụng.

13. Trình tự
hoặc quy trình.

14. Suy luận trực tiếp
từ nội dung đã học.

15. Tình huống
áp dụng kiến thức.


LƯU Ý:

Câu Kiến thức
KHÔNG có nghĩa là
chỉ được hỏi định nghĩa.

Câu Kiến thức
vẫn có thể là:

- Trung bình.

- Khó.

- Phân biệt.

- Phân tích nguyên nhân.

- Chọn phát biểu đúng nhất.

- Suy luận trực tiếp
  từ tài liệu.


==================================================
PHÂN BỐ ĐỘ KHÓ
==================================================

${difficultyText}


${questionModeText}


==================================================
CHỐNG TRÙNG
==================================================

Các câu dưới đây
đã xuất hiện.

TUYỆT ĐỐI KHÔNG LẶP.

Không lặp nguyên câu.

Không lặp cùng một ý.

Không chỉ diễn đạt lại.

Không chỉ đổi
thứ tự đáp án.

Không chỉ đổi
tên nhân vật.


${JSON.stringify(
  promptExclude
)}


==================================================
ƯU TIÊN KIẾN THỨC MỚI
==================================================

Ưu tiên:

- khái niệm chưa hỏi

- đặc điểm chưa hỏi

- chức năng chưa hỏi

- vai trò chưa hỏi

- nguyên nhân chưa hỏi

- kết quả chưa hỏi

- mối quan hệ chưa hỏi

- quy trình chưa hỏi

- ví dụ khác

- tình huống khác

- góc nhìn khác


Nếu tài liệu có nhiều phần,
hãy phân bố câu hỏi
trên nhiều phần.


==================================================
JSON
==================================================

Chỉ trả JSON hợp lệ.

KHÔNG Markdown.

KHÔNG viết nội dung
bên ngoài JSON.


Nhắc lại:

${languageInfo.instruction}


Cấu trúc:

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
      "k": "Kiến thức"
    }
  ],
  "note": ""
}


Quy ước:

c:

0 = A
1 = B
2 = C
3 = D


l:

1 = Dễ
2 = Trung bình
3 = Khó


k:

chỉ dùng:

"Kiến thức"

hoặc

"Vận dụng"


==================================================
TÀI LIỆU / SOURCE MATERIAL
==================================================

${text}
`;
}


/* =========================================================
   PARSE JSON
========================================================= */

function parseQuiz(raw) {
  if (
    typeof raw !==
      "string" ||

    !raw.trim()
  ) {
    throw new Error(
      "AI không trả nội dung."
    );
  }

  let text =
    raw
      .trim()
      .replace(
        /^```(?:json)?\s*/i,
        ""
      )
      .replace(
        /\s*```$/,
        ""
      );

  /*
   * Cho phép AI
   * lỡ thêm chữ trước/sau JSON.
   */
  const firstBrace =
    text.indexOf("{");

  const lastBrace =
    text.lastIndexOf("}");

  if (
    firstBrace >= 0 &&
    lastBrace >
      firstBrace
  ) {
    text =
      text.slice(
        firstBrace,
        lastBrace + 1
      );
  }

  const quiz =
    JSON.parse(
      text
    );

  if (
    !quiz ||

    !Array.isArray(
      quiz.questions
    )
  ) {
    throw new Error(
      "AI trả sai cấu trúc JSON."
    );
  }

  return quiz;
}


/* =========================================================
   HTTP
========================================================= */

async function postJSON(
  url,
  headers,
  body,
  timeoutMs
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      timeoutMs
    );

  try {
    const response =
      await fetch(
        url,
        {
          method:
            "POST",

          signal:
            controller.signal,

          headers: {
            "Content-Type":
              "application/json",

            ...headers
          },

          body:
            JSON.stringify(
              body
            )
        }
      );

    if (
      !response.ok
    ) {
      const error =
        new Error(
          "Provider HTTP " +
          response.status
        );

      error.status =
        response.status;

      throw error;
    }

    return (
      await response.json()
    );

  } finally {
    clearTimeout(
      timer
    );
  }
}


/* =========================================================
   GEMINI
========================================================= */

async function requestGemini(
  provider,
  prompt,
  timeoutMs
) {
  const generationConfig = {
    responseMimeType:
      "application/json",

    maxOutputTokens:
      8192
  };

  /*
   * Gemini 3+
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
    ].includes(
      provider.thinking
    )
  ) {
    generationConfig
      .thinkingConfig = {
      thinkingLevel:
        provider.thinking
    };
  }

  /*
   * Gemini cũ.
   */
  if (
    !/^gemini-[3-9]/i.test(
      provider.model
    )
  ) {
    generationConfig
      .temperature =
      0.8;
  }

  const model =
    provider.model
      .replace(
        /^models\//,
        ""
      );

  const data =
    await postJSON(
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
            role:
              "user",

            parts: [
              {
                text:
                  prompt
              }
            ]
          }
        ],

        generationConfig
      },

      timeoutMs
    );

  const raw =
    data
      .candidates?.[0]
      ?.content
      ?.parts

      ?.filter(
        part =>
          !part.thought
      )

      .map(
        part =>
          part.text ||
          ""
      )

      .join("");

  return parseQuiz(
    raw
  );
}


/* =========================================================
   GROQ
========================================================= */

async function requestGroq(
  provider,
  prompt,
  timeoutMs
) {
  const data =
    await postJSON(
      "https://api.groq.com/openai/v1/chat/completions",

      {
        Authorization:
          "Bearer " +
          provider.key
      },

      {
        model:
          provider.model,

        messages: [
          {
            role:
              "system",

            content:
              "You create multiple-choice quizzes from supplied source material. Preserve the source material's language for questions, choices, explanations and topic labels. Return valid JSON only."
          },

          {
            role:
              "user",

            content:
              prompt
          }
        ],

        response_format: {
          type:
            "json_object"
        },

        temperature:
          0.8,

        max_tokens:
          8192
      },

      timeoutMs
    );

  return parseQuiz(
    data
      .choices?.[0]
      ?.message
      ?.content
  );
}


/* =========================================================
   PROVIDERS
========================================================= */

function getProviders() {
  const providers = [];

  const geminiKey =
    env(
      "GEMINI_API_KEY"
    );

  const primary =
    env(
      "GEMINI_MODEL"
    );

  const fallback =
    env(
      "GEMINI_FALLBACK_MODEL"
    );

  const thinking =
    env(
      "GEMINI_FALLBACK_THINKING"
    ).toLowerCase();

  /*
   * Gemini chính.
   */
  if (
    geminiKey &&

    primary &&

    primary.toLowerCase() !==
      "none"
  ) {
    providers.push({
      type:
        "gemini",

      model:
        primary,

      key:
        geminiKey,

      thinking
    });
  }

  /*
   * Gemini dự phòng.
   */
  if (
    geminiKey &&

    fallback &&

    fallback.toLowerCase() !==
      "none" &&

    fallback !==
      primary
  ) {
    providers.push({
      type:
        "gemini",

      model:
        fallback,

      key:
        geminiKey,

      thinking
    });
  }

  /*
   * Groq dự phòng.
   */
  const groqKey =
    env(
      "GROQ_API_KEY"
    );

  const groqModel =
    env(
      "GROQ_MODEL"
    );

  if (
    groqKey &&

    groqModel &&

    groqModel.toLowerCase() !==
      "none"
  ) {
    providers.push({
      type:
        "groq",

      model:
        groqModel,

      key:
        groqKey
    });
  }

  return providers;
}


/* =========================================================
   MAIN NETLIFY FUNCTION
========================================================= */

exports.handler =
async function handler(event) {

  /* CORS */
  if (
    event.httpMethod ===
    "OPTIONS"
  ) {
    return reply(
      204,
      {}
    );
  }

  /*
   * Chỉ POST.
   */
  if (
    event.httpMethod !==
    "POST"
  ) {
    return reply(
      405,
      {
        error:
          "Chỉ hỗ trợ POST."
      }
    );
  }

  let input;

  /*
   * Parse JSON input.
   */
  try {
    input =
      JSON.parse(
        event.body ||
        "{}"
      );

  } catch {
    return reply(
      400,
      {
        error:
          "Dữ liệu JSON không hợp lệ."
      }
    );
  }

  if (
    !input ||

    typeof input !==
      "object" ||

    Array.isArray(
      input
    )
  ) {
    return reply(
      400,
      {
        error:
          "Dữ liệu gửi lên không hợp lệ."
      }
    );
  }


  /* =====================================================
     TEXT
  ===================================================== */

  const text =
    typeof input.text ===
      "string"

      ? input.text
          .trim()
          .slice(
            0,
            16000
          )

      : "";


  /* =====================================================
     SUBJECT
  ===================================================== */

  const subject =
    typeof input.subject ===
      "string"

      ? input.subject
          .trim()
          .slice(
            0,
            300
          )

      : "";


  /* =====================================================
     LEVEL
  ===================================================== */

  const level =
    input.level;


  /* =====================================================
     QUIZ MODE
  ===================================================== */

  /*
   * source =
   * Chỉ bám sát tài liệu.
   *
   * apply =
   * Có vận dụng.
   *
   * Nếu frontend cũ
   * chưa gửi quizMode
   * thì mặc định source.
   */
  const quizMode =
    QUIZ_MODES.has(
      input.quizMode
    )

      ? input.quizMode

      : "source";


  /* =====================================================
     COUNT
  ===================================================== */

  const requested =
    Number(
      input.count
    );

  const count =
    Number.isFinite(
      requested
    )

      ? Math.min(
          Math.max(
            Math.floor(
              requested
            ),
            1
          ),
          50
        )

      : 10;


  /* =====================================================
     EXCLUDE
  ===================================================== */

  const exclude =
    Array.isArray(
      input.exclude
    )

      ? input.exclude

          .filter(
            q =>
              typeof q ===
                "string" &&
              q.trim()
          )

          .slice(
            -600
          )

          .map(
            q =>
              q
                .trim()
                .slice(
                  0,
                  700
                )
          )

      : [];


  /* =====================================================
     VALIDATE INPUT
  ===================================================== */

  if (
    text.length < 100
  ) {
    return reply(
      400,
      {
        error:
          "Tài liệu cần ít nhất 100 ký tự."
      }
    );
  }

  if (
    !LEVELS.has(
      level
    )
  ) {
    return reply(
      400,
      {
        error:
          "Mức độ câu hỏi không hợp lệ."
      }
    );
  }


  /* =====================================================
     PROVIDERS
  ===================================================== */

  const providers =
    getProviders();

  if (
    !providers.length
  ) {
    return reply(
      500,
      {
        error:
          "Chưa có cặp API key và model hợp lệ trong cấu hình."
      }
    );
  }


  /* =====================================================
     STATE
  ===================================================== */

  const questions = [];

  let note = "";

  let receivedResponse =
    false;

  let attempts = 0;

  /*
   * Tổng thời gian.
   */
  const deadline =
    Date.now() +
    50000;

  /*
   * Nhiều vòng
   * để bù câu thiếu.
   */
  const MAX_ATTEMPTS =
    Math.max(
      6,

      providers.length *
      4
    );


  /* =====================================================
     TARGET DIFFICULTY
  ===================================================== */

  const difficultyPlan =
    getDifficultyPlan(
      count,
      level
    );


  /* =====================================================
     TARGET APPLICATION
  ===================================================== */

  const applicationTarget =
    targetAppCount(
      count,
      quizMode
    );


  /* =====================================================
     GENERATION LOOP
  ===================================================== */

  while (
    !enoughForTarget(
      questions,
      count,
      level
    ) &&

    attempts <
      MAX_ATTEMPTS
  ) {
    const remainingMs =
      deadline -
      Date.now();

    /*
     * Không gọi request mới
     * nếu gần hết thời gian.
     */
    if (
      remainingMs <
      4500
    ) {
      break;
    }


    /* =================================================
       PROVIDER
    ================================================= */

    const provider =
      providers[
        attempts %
        providers.length
      ];

    attempts++;


    /* =================================================
       EXCLUDE
    ================================================= */

    const allExcluded = [
      ...exclude,

      ...questions.map(
        q =>
          q.q
      )
    ];


    /* =================================================
       CURRENT LEVELS
    ================================================= */

    const currentLevels =
      countLevels(
        questions
      );

    const difficultyNeeded = {
      easy:
        Math.max(
          0,

          difficultyPlan.easy -
          currentLevels.easy
        ),

      medium:
        Math.max(
          0,

          difficultyPlan.medium -
          currentLevels.medium
        ),

      hard:
        Math.max(
          0,

          difficultyPlan.hard -
          currentLevels.hard
        )
    };


    /* =================================================
       APPLICATION NEEDED
    ================================================= */

    const currentApplication =
      questions.filter(
        q =>
          q.k ===
          "Vận dụng"
      ).length;

    const applicationNeeded =
      Math.max(
        0,

        applicationTarget -
        currentApplication
      );


    /* =================================================
       HOW MANY NEEDED
    ================================================= */

    let needed;

    if (
      level ===
      "Trộn tất cả"
    ) {
      needed =
        difficultyNeeded.easy +

        difficultyNeeded.medium +

        difficultyNeeded.hard;

    } else {
      const targetLevel =
        normalizeLevel(
          level
        );

      needed =
        count -

        questions.filter(
          q =>
            q.l ===
            targetLevel
        ).length;
    }

    needed =
      Math.max(
        1,
        needed
      );


    /* =================================================
       PROMPT
    ================================================= */

    const prompt =
      createPrompt({
        text,

        count:
          needed,

        totalCount:
          count,

        level,

        subject,

        exclude:
          allExcluded,

        round:
          attempts,

        applicationNeeded,

        difficultyNeeded,

        quizMode
      });


    /* =================================================
       TIMEOUT
    ================================================= */

    const timeoutMs =
      Math.min(
        26000,

        Math.max(
          4500,

          Math.floor(
            remainingMs /
            2
          )
        )
      );


    /* =================================================
       CALL AI
    ================================================= */

    try {
      const quiz =
        provider.type ===
          "groq"

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

      receivedResponse =
        true;


      /* =================================================
         CLEAN RESULT
      ================================================= */

      const fresh =
        cleanQuestions(
          quiz.questions,

          allExcluded,

          Math.max(
            needed * 3,
            12
          ),

          quizMode
        );

      questions.push(
        ...fresh
      );


      /* =================================================
         NOTE
      ================================================= */

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
       * Không log:
       * API key
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
            error.status ||
            null,

          type:
            error.name
        }
      );
    }
  }


  /* =====================================================
     ALL PROVIDERS FAILED
  ===================================================== */

  if (
    !questions.length &&
    !receivedResponse
  ) {
    return reply(
      502,
      {
        error:
          "Các dịch vụ AI đều chưa tạo được đề. Kiểm tra API key, model và hạn mức rồi thử lại."
      }
    );
  }


  /* =====================================================
     FINAL DIFFICULTY
  ===================================================== */

  let finalQuestions =
    selectBalancedQuestions(
      questions,
      count,
      level
    );


  /* =====================================================
     FINAL APPLICATION
  ===================================================== */

  finalQuestions =
    rebalanceApplication(
      finalQuestions,
      questions,
      count,
      quizMode
    );


  /* =====================================================
     META
  ===================================================== */

  const counts =
    countLevels(
      finalQuestions
    );

  const applicationCount =
    finalQuestions.filter(
      q =>
        q.k ===
        "Vận dụng"
    ).length;


  /* =====================================================
     RESPONSE
  ===================================================== */

  return reply(
    200,
    {
      questions:
        finalQuestions,

      meta: {
        requested:
          count,

        generated:
          finalQuestions.length,

        easy:
          counts.easy,

        medium:
          counts.medium,

        hard:
          counts.hard,

        knowledgeQuestions:
          finalQuestions.length -
          applicationCount,

        applicationQuestions:
          applicationCount,

        /*
         * en   = English
         * vi   = Vietnamese
         * same = ngôn ngữ khác
         */
        sourceLanguage:
          detectLanguage(
            text
          ),

        /*
         * source =
         * chỉ bám sát tài liệu
         *
         * apply =
         * có vận dụng
         */
        quizMode,

        attempts
      },

      note:
        finalQuestions.length <
        count

          ? [
              `Tạo được ${finalQuestions.length}/${count} câu hợp lệ.`,

              note ||
              "Tài liệu có thể chưa đủ nội dung mới hoặc AI chưa trả đủ đúng mức độ yêu cầu."
            ].join(" ")

          : ""
    }
  );
};

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

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};


/* =========================================================
   RESPONSE
========================================================= */

function reply(statusCode, data) {
  return {
    statusCode,
    headers: HEADERS,
    body:
      statusCode === 204
        ? ""
        : JSON.stringify(data)
  };
}


/* =========================================================
   ENV
========================================================= */

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
  "la",
  "gi",
  "nao",
  "sau",
  "day",
  "trong",
  "cac",
  "mot",
  "nhung",
  "va",
  "voi",
  "cua",
  "cho",
  "khi",
  "theo",
  "duoc",
  "ve",
  "co",
  "khong",
  "dung",
  "nhat",
  "hay",
  "phat",
  "bieu",
  "lua",
  "chon",
  "dap",
  "an",
  "noi",
  "hoi",
  "truong",
  "hop"
]);


/* =========================================================
   TOKEN SET
========================================================= */

function tokenSet(text) {
  return new Set(
    normalize(text)
      .split(" ")
      .filter(
        word =>
          word.length > 2 &&
          !STOP_WORDS.has(word)
      )
  );
}


/* =========================================================
   BIGRAM
========================================================= */

function bigrams(text) {
  const words = normalize(text)
    .split(" ")
    .filter(Boolean);

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


/* =========================================================
   JACCARD
========================================================= */

function jaccard(a, b) {
  if (
    !a.size ||
    !b.size
  ) {
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
   CHECK DUPLICATE / SIMILAR
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


  /*
   * Trùng hoàn toàn
   */
  if (
    first === second
  ) {
    return true;
  }


  /*
   * Một câu gần như
   * chứa nguyên câu còn lại
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
   * Đặt ngưỡng tương đối cao.
   *
   * Mục tiêu:
   * - bắt câu thật sự trùng
   * - không loại nhầm:
   *
   * "Random Forest là gì?"
   * và
   * "Logistic Regression là gì?"
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
   VALID QUESTION
========================================================= */

function validQuestion(q) {
  return (

    q &&

    typeof q.q ===
      "string" &&

    q.q.trim().length >=
      8 &&

    !/điền từ|chỗ trống|_{3,}/i
      .test(q.q) &&

    Array.isArray(q.o) &&

    q.o.length === 4 &&

    q.o.every(
      option =>
        typeof option ===
          "string" &&
        option.trim()
    ) &&

    new Set(
      q.o.map(normalize)
    ).size === 4 &&

    Number.isInteger(q.c) &&

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
    [1, 2, 3].includes(value)
  ) {
    return value;
  }

  const levels = {
    "Dễ": 1,
    "Trung bình": 2,
    "Khó": 3
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
  limit
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
   EXCLUDE SENT TO AI
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


    output.push(item);

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
   * Nếu người dùng
   * chọn riêng một mức
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
   * Trộn tất cả:
   *
   * chia gần đều.
   *
   * 10:
   * 3 dễ
   * 4 trung bình
   * 3 khó
   *
   * 30:
   * 10 / 10 / 10
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
  count
) {

  /*
   * Khoảng 20%
   */
  return Math.max(
    1,
    Math.round(
      count * 0.20
    )
  );
}


/* =========================================================
   CHECK IF WE REALLY HAVE ENOUGH
========================================================= */

function enoughForTarget(
  questions,
  count,
  level
) {

  /*
   * Chọn riêng một mức:
   *
   * chỉ tính những câu
   * đúng mức đó.
   *
   * Đây là phần sửa lỗi
   * dừng quá sớm.
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
   *
   * phải đủ từng nhóm
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
   * Chọn riêng một mức
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
          q.l === target
      )
      .slice(
        0,
        count
      );
  }


  /*
   * Trộn
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
   REBALANCE APPLICATION QUESTIONS
========================================================= */

function rebalanceApplication(
  finalQuestions,
  pool,
  count
) {

  const target =
    targetAppCount(
      count
    );


  /*
   * Mục tiêu khoảng 20%.
   *
   * Cho phép dư nhẹ
   * đến khoảng 25%
   * trong trường hợp AI
   * không trả đủ câu kiến thức.
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


  /*
   * Các câu đã chọn
   */
  const used =
    new Set(
      finalQuestions.map(
        q =>
          normalize(q.q)
      )
    );


  /*
   * Tìm câu kiến thức
   * thay thế THEO ĐÚNG
   * mức độ tương ứng.
   *
   * Nhờ vậy:
   *
   * thay 1 câu vận dụng Khó
   * bằng 1 câu kiến thức Khó.
   *
   * Không làm hỏng tỷ lệ
   * Dễ / Trung bình / Khó.
   */
  const knowledgeByLevel = {

    1:
      pool.filter(
        q =>
          q.k !==
            "Vận dụng" &&
          q.l === 1 &&
          !used.has(
            normalize(q.q)
          )
      ),

    2:
      pool.filter(
        q =>
          q.k !==
            "Vận dụng" &&
          q.l === 2 &&
          !used.has(
            normalize(q.q)
          )
      ),

    3:
      pool.filter(
        q =>
          q.k !==
            "Vận dụng" &&
          q.l === 3 &&
          !used.has(
            normalize(q.q)
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
  difficultyNeeded
}) {

  /*
   * Tạo dư câu
   * để còn lọc trùng/lỗi.
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


  let difficultyText;


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


  return `
Bạn là giáo viên chuyên soạn câu hỏi trắc nghiệm bằng tiếng Việt.

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

- Không dùng dấu ___ để che nội dung.

- Không dùng kiến thức ngoài tài liệu.

- Không tự bịa kiến thức để đủ câu.

- Không tạo hai câu kiểm tra cùng một ý
  rồi chỉ thay đổi cách diễn đạt.

- Không chỉ đổi tên người
  hoặc tên công ty
  rồi xem là câu mới.

- Không chỉ đảo thứ tự đáp án.

- Đáp án nhiễu phải hợp lý.

- Các lựa chọn phải cùng phạm vi kiến thức.

- Lời giải phải ít nhất 20 ký tự.

- Lời giải phải giải thích
  vì sao đáp án đúng.


==================================================
ĐA DẠNG KIỂU CÂU HỎI
==================================================

Hãy kết hợp nhiều dạng câu.

KHÔNG chỉ tạo câu định nghĩa.

Các dạng được phép và nên sử dụng:

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

11. Mối quan hệ giữa các khái niệm.

12. Điều kiện áp dụng.

13. Trình tự hoặc quy trình.

14. Suy luận trực tiếp
    từ nội dung đã học.

15. Tình huống áp dụng kiến thức.


LƯU Ý:

80% câu Kiến thức
KHÔNG có nghĩa
80% là câu định nghĩa đơn giản.

Câu Kiến thức vẫn có thể là:

- Trung bình.

- Khó.

- Phân biệt.

- Phân tích nguyên nhân.

- Chọn phát biểu đúng nhất.

- Suy luận trực tiếp từ tài liệu.


==================================================
PHÂN BỐ ĐỘ KHÓ
==================================================

${difficultyText}


==================================================
TỶ LỆ KIẾN THỨC / VẬN DỤNG
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


==================================================
CÂU VẬN DỤNG
==================================================

Câu vận dụng có thể:

- Đưa kiến thức vào tình huống mới.

- Yêu cầu chọn cách xử lý phù hợp.

- Yêu cầu suy luận kết quả.

- Yêu cầu áp dụng kiến thức
  đã học vào trường hợp cụ thể.


Ví dụ dạng hỏi:

"Trong trường hợp trên,
phương án nào phù hợp nhất?"

"Nếu điều kiện thay đổi,
kết quả nào hợp lý nhất?"

"Kiến thức nào nên được áp dụng
trong tình huống trên?"


Nhưng:

Không tạo câu vận dụng giả
bằng cách chỉ thêm:

"Anh A..."

"Bạn B..."

"Công ty C..."

rồi phía sau
vẫn chỉ hỏi lại định nghĩa.


Nếu câu hỏi thực chất
chỉ là nhận biết hoặc lý thuyết

thì ghi:

"k": "Kiến thức"


==================================================
CHỐNG TRÙNG
==================================================

Các câu dưới đây
đã xuất hiện.

TUYỆT ĐỐI KHÔNG LẶP.

Không lặp nguyên câu.

Không lặp cùng một ý.

Không chỉ diễn đạt lại.

Không chỉ đổi thứ tự đáp án.

Không chỉ đổi tên nhân vật.


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
TÀI LIỆU
==================================================

${text}
`;
}


/* =========================================================
   PARSE AI JSON
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
   * Nếu AI thêm chữ
   * trước hoặc sau JSON
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
    JSON.parse(text);


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
   HTTP REQUEST
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
    /^gemini-[3-9]/i
      .test(
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
   * Model Gemini cũ
   */
  if (
    !/^gemini-[3-9]/i
      .test(
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
              "Bạn soạn đề trắc nghiệm. Chỉ trả JSON hợp lệ."
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
    )
      .toLowerCase();


  /*
   * Gemini chính
   */
  if (
    geminiKey &&

    primary &&

    primary
      .toLowerCase() !==
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
   * Gemini dự phòng
   */
  if (
    geminiKey &&

    fallback &&

    fallback
      .toLowerCase() !==
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
   * Groq
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

    groqModel
      .toLowerCase() !==
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
   MAIN HANDLER
========================================================= */

exports.handler =
async function handler(event) {


  /*
   * CORS
   */
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
   * Chỉ POST
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
   * Parse input
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

    Array.isArray(input)
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

  /*
   * Các câu đã tạo
   * ở các lần trước.
   *
   * Backend nhận tối đa 600 câu.
   */
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
     VALIDATION
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
     PROVIDER
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

  let attempts =
    0;


  /*
   * Tổng thời gian
   */
  const deadline =
    Date.now() +
    50000;


  /*
   * Nhiều vòng hơn
   * để có khả năng bù đủ.
   */
  const MAX_ATTEMPTS =
    Math.max(
      6,

      providers.length *
      4
    );


  /* =====================================================
     TARGETS
  ===================================================== */

  const difficultyPlan =
    getDifficultyPlan(
      count,
      level
    );


  const applicationTarget =
    targetAppCount(
      count
    );


  /* =====================================================
     GENERATION LOOP
  ===================================================== */

  /*
   * KHÔNG dừng chỉ vì
   * questions.length >= count.
   *
   * Chỉ dừng khi đủ
   * đúng tỷ lệ độ khó.
   *
   * Đây là phần sửa lỗi
   * quan trọng nhất.
   */
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


    if (
      remainingMs <
      4500
    ) {
      break;
    }


    /*
     * Luân phiên:
     *
     * Gemini chính
     * Gemini fallback
     * Groq
     */
    const provider =
      providers[
        attempts %
        providers.length
      ];


    attempts++;


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
       HOW MANY STILL NEEDED?
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

        difficultyNeeded
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


      /*
       * Lấy dư câu
       * để còn cân bằng.
       */
      const fresh =

        cleanQuestions(

          quiz.questions,

          allExcluded,

          Math.max(
            needed * 3,
            12
          )
        );


      questions.push(
        ...fresh
      );


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
            error.status ||
            null,

          type:
            error.name
        }
      );
    }
  }


  /* =====================================================
     ALL AI FAILED
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
     FINAL DIFFICULTY BALANCE
  ===================================================== */

  let finalQuestions =

    selectBalancedQuestions(
      questions,
      count,
      level
    );


  /* =====================================================
     FINAL APPLICATION BALANCE
  ===================================================== */

  finalQuestions =

    rebalanceApplication(

      finalQuestions,

      questions,

      count
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

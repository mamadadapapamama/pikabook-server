// ==========================================
// Cloud Functions - Post-LLM 전용 (번역만)
// functions/index.js
// ==========================================
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onRequest} = require("firebase-functions/v2/https");
const {initializeApp} = require("firebase-admin/app");

const {OpenAI} = require("openai");

initializeApp();

/**
 * OpenAI 클라이언트 생성 함수
 * @return {OpenAI} OpenAI 클라이언트 인스턴스
 */
function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OpenAI API key not configured");
  }

  return new OpenAI({
    apiKey: apiKey,
    timeout: 30000, // 30초 타임아웃
  });
}

// ===========================================
// HTTP 스트리밍 번역 함수 (실시간 처리)
// ===========================================
exports.translateSegmentsStream = onRequest({
  timeoutSeconds: 300,
  memory: "1GiB",
  region: "asia-southeast1",
  secrets: ["OPENAI_API_KEY"],
}, async (req, res) => {
  // CORS 설정
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // 스트리밍 헤더 설정
  res.writeHead(200, {
    "Content-Type": "text/plain",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  try {
    const {
      textSegments,
      pageSegments, // 페이지별 세그먼트 정보 추가
      targetLanguage = "ko",
      needPinyin = true,
      processingMode, // 클라이언트 처리 모드 (differential update 감지용)
    } = req.body;

    // Differential Update 모드 감지
    const useDifferentialUpdate = processingMode === 'TextProcessingMode.segment';
    
    console.log(`🌊 [스트리밍] 번역 시작: ${textSegments.length}개 세그먼트`);
    console.log(`🔄 [Processing Mode] ${processingMode}`);
    console.log(`📦 [Differential Update] ${useDifferentialUpdate ? '활성화' : '비활성화'}`);

    // 페이지별로 세그먼트 그룹핑
    if (pageSegments && pageSegments.length > 0) {
      // 페이지별 처리
      console.log(`📄 페이지별 처리: ${pageSegments.length}개 페이지`);

      let totalChunks = 0;
      for (const pageInfo of pageSegments) {
        totalChunks += Math.ceil(pageInfo.segments.length / 3);
      }

      let chunkIndex = 0;

      for (const pageInfo of pageSegments) {
        const CHUNK_SIZE = 3;
        const pageChunks = splitIntoChunks(pageInfo.segments, CHUNK_SIZE);

        for (let i = 0; i < pageChunks.length; i++) {
          try {
            console.log(`📦 [스트리밍] 페이지 ${pageInfo.pageId} 청크 ${i + 1}/${pageChunks.length} 처리 중`);

            // 현재 청크의 시작 인덱스 계산 (differential update용)
            const chunkStartIndex = i * 3; // CHUNK_SIZE = 3
            // 처리 모드 결정
            const translationMode = processingMode === 'TextProcessingMode.paragraph' ? 'paragraph' : 'segment';
            
            const chunkResult = await translateChunk(
              pageChunks[i], 
              targetLanguage, 
              needPinyin, 
              translationMode, 
              useDifferentialUpdate, 
              chunkStartIndex
            );

            // 페이지별 청크 결과를 즉시 스트리밍
            const streamData = {
              chunkIndex: chunkIndex,
              totalChunks: totalChunks,
              pageId: pageInfo.pageId, // 페이지 ID 포함
              units: chunkResult.units,
              mode: chunkResult.mode, // ✅ differential/full 모드 전달
              isComplete: chunkIndex === totalChunks - 1,
            };

            // Differential Update 모드에서 대역폭 절약 로깅
            if (useDifferentialUpdate && chunkResult.useDifferentialUpdate) {
              const savedChars = pageChunks[i].join('').length;
              console.log(`📊 [Bandwidth Saved] ${savedChars}자 (원문 전송 생략)`);
            }

            res.write(`data: ${JSON.stringify(streamData)}\n\n`);

            console.log(`✅ [스트리밍] 페이지 ${pageInfo.pageId} 청크 ${chunkIndex + 1} 전송 완료`);
            chunkIndex++;
          } catch (error) {
            console.error(`❌ [스트리밍] 페이지 ${pageInfo.pageId} 청크 ${i} 실패:`, error);

            const errorData = {
              chunkIndex: chunkIndex,
              pageId: pageInfo.pageId,
              error: error.message,
              isError: true,
            };
            res.write(`data: ${JSON.stringify(errorData)}\n\n`);
            chunkIndex++;
          }
        }
      }
    } else {
      // 기존 방식 (단일 페이지 또는 페이지 정보 없음)
      let chunks;
      
      if (processingMode === 'TextProcessingMode.paragraph') {
        // 문단 모드: 의미 단위로 스마트 분할
        console.log(`📄 [문단모드] 스마트 청킹 시작: ${textSegments[0]?.length || 0}자`);
        const textChunks = smartSplitForParagraphMode(textSegments[0] || '');
        // 문자열 배열을 세그먼트 배열로 변환
        chunks = textChunks.map(chunk => [chunk]); // 각 청크를 배열로 감싸기
        console.log(`📄 [문단모드] 스마트 청킹 완료: ${chunks.length}개 청크`);
      } else {
        // 세그먼트 모드: 기존 방식
        const CHUNK_SIZE = 3;
        chunks = splitIntoChunks(textSegments, CHUNK_SIZE);
      }

      for (let i = 0; i < chunks.length; i++) {
        try {
          console.log(`📦 [스트리밍] 청크 ${i + 1}/${chunks.length} 처리 중`);

          // 현재 청크의 시작 인덱스 계산 (differential update용)
          const chunkStartIndex = i * 3; // CHUNK_SIZE = 3
          // 처리 모드 결정
          const translationMode = processingMode === 'TextProcessingMode.paragraph' ? 'paragraph' : 'segment';
          
          const chunkResult = await translateChunk(
            chunks[i], 
            targetLanguage, 
            needPinyin, 
            translationMode, 
            useDifferentialUpdate, 
            chunkStartIndex
          );

          // 청크 결과를 즉시 스트리밍
          const streamData = {
            chunkIndex: i,
            totalChunks: chunks.length,
            units: chunkResult.units,
            mode: chunkResult.mode, // ✅ differential/full 모드 전달
            isComplete: i === chunks.length - 1,
          };

          // Differential Update 모드에서 대역폭 절약 로깅
          if (useDifferentialUpdate && chunkResult.useDifferentialUpdate) {
            const savedChars = chunks[i].join('').length;
            console.log(`📊 [Bandwidth Saved] ${savedChars}자 (원문 전송 생략)`);
          }

          res.write(`data: ${JSON.stringify(streamData)}\n\n`);

          console.log(`✅ [스트리밍] 청크 ${i + 1} 전송 완료`);
        } catch (error) {
          console.error(`❌ [스트리밍] 청크 ${i} 실패:`, error);

          const errorData = {
            chunkIndex: i,
            error: error.message,
            isError: true,
          };
          res.write(`data: ${JSON.stringify(errorData)}\n\n`);
        }
      }
    }

    res.end();
    console.log(`🏁 [스트리밍] 모든 청크 전송 완료`);
  } catch (error) {
    console.error("❌ [스트리밍] 전체 오류:", error);
    res.status(500).json({error: error.message});
  }
});

// ===========================================
// 텍스트 세그먼트 번역 함수 (Post-LLM만)
// ===========================================
exports.translateSegments = onCall({
  timeoutSeconds: 300,
  memory: "1GiB",
  region: "asia-southeast1", // 싱가포르 리전으로 변경
  secrets: ["OPENAI_API_KEY"], // secret 사용 선언
}, async (request) => {
  console.log(`🔥 [DEBUG] translateSegments 함수 시작!`);
  console.log(`🔥 [DEBUG] 사용자: ${request.auth ? request.auth.uid : "N/A"}`);

  if (!request.auth) {
    throw new HttpsError("unauthenticated", "로그인 필요");
  }

  const {
    textSegments,
    sourceLanguage = "zh-CN",
    targetLanguage = "ko",
    needPinyin = true,
    mode = "segment",
    pageId,
    noteId,
  } = request.data;

  console.log(
      `🤖 Translating ${textSegments.length} segments ` +
      `for user: ${request.auth.uid} (모드: ${mode})`,
  );
  console.log(`📄 Page: ${pageId}, Note: ${noteId}`);

  try {
    const startTime = Date.now();

    // 1. 배치 번역 처리 (핵심 최적화!)
    console.log(`🔥 [DEBUG] optimizedBatchTranslateSegments 호출 직전 (모드: ${mode})`);
    const translationResult = await optimizedBatchTranslateSegments(
        textSegments,
        sourceLanguage,
        targetLanguage,
        needPinyin,
        mode,
    );
    console.log(`🔥 [DEBUG] optimizedBatchTranslateSegments 호출 완료`);



    const processingTime = Date.now() - startTime;
    console.log(`✅ Translation completed in ${processingTime}ms`);

    return {
      success: true,
      translation: translationResult,
      statistics: {
        segmentCount: textSegments.length,
        totalCharacters: textSegments.join("").length,
        processingTime: processingTime,
      },
    };
  } catch (error) {
    console.error("❌ Translation error:", error);
    throw new HttpsError("internal", `번역 실패: ${error.message}`);
  }
});

/**
 * 단일 청크 번역/분할 처리
 * @param {Array} segments 처리할 세그먼트 배열
 * @param {string} targetLanguage 타겟 언어
 * @param {boolean} needPinyin 병음 필요 여부
 * @param {string} mode 처리 모드 ('segment' | 'paragraph')
 * @return {Object} 처리 결과
 */
async function translateChunk(segments, targetLanguage, needPinyin, mode = "segment", useDifferentialUpdate = false, startIndex = 0) {
  console.log(`🔄 translateChunk 시작: ${segments.length}개 세그먼트 (모드: ${mode})`);
  const firstSegment = segments[0] ? segments[0].substring(0, 50) : "";
  console.log(`📝 첫 번째 세그먼트: "${firstSegment}..."`);

  try {
    const openai = getOpenAIClient();
    console.log(`✅ OpenAI 클라이언트 생성 완료`);

    let systemPrompt; let userPrompt;

    if (mode === "paragraph") {
      // 📚 Paragraph 모드: 교육용 텍스트 분할 + 번역 (병음 없음)
      systemPrompt = `You are a Chinese language education assistant.
You will receive raw Chinese text from a scanned worksheet or textbook (after OCR cleaning).

Your job is to:
1. Segment this text into meaningful educational blocks
2. Translate each block to Korean (NO pinyin needed)

Educational block types:
- title (lesson title or section header)
- instruction (e.g. "Read the passage and answer the questions.")
- passage (reading text)
- vocabulary (key words or phrases)
- question (quiz question)
- choices (multiple choice options A/B/C...)
- answer (correct answer, if provided)
- dialogue (conversation lines)

Keep each segment short and complete.
Preserve the original order unless it clearly needs adjustment.

Return a JSON array in this format:

\`\`\`json
[
  {
    "type": "title",
    "original": "第二课 学校里",
    "translation": "제2과 학교에서"
  },
  {
    "type": "instruction", 
    "original": "请你阅读短文，然后回答问题。",
    "translation": "다음 단문을 읽고 질문에 답하세요."
  },
  {
    "type": "passage",
    "original": "开学了，我去学校上课。",
    "translation": "개학했고, 나는 학교에 수업을 들으러 간다."
  },
  {
    "type": "question",
    "original": "小明去哪里上课？",
    "translation": "샤오밍은 어디에 수업을 들으러 갔나요?"
  },
  {
    "type": "choices",
    "original": "A. 学校 B. 家里 C. 公园",
    "translation": "A. 학교 B. 집 C. 공원"
  }
]
\`\`\`

CRITICAL: Only return valid JSON array. No markdown blocks, no explanations, no comments.
Do not use smart quotes (""''). Use only regular quotes ("").
Do not add trailing commas.`;

      userPrompt = `Process the following Chinese educational text - segment it into meaningful blocks and translate to Korean:

${segments.join("\n")}

Return ONLY a valid JSON array following the format above. Do not wrap in markdown code blocks.`;
    } else {
              // 🔤 Segment 모드: 항상 번역 + 병음 (문장 병합 방지)
        systemPrompt = `You are a Chinese-Korean translator. Translate Chinese text segments to Korean and provide pinyin for each segment. Keep each segment separate - do NOT merge or combine segments. 

CRITICAL: Only return valid JSON array. No markdown blocks, no explanations, no comments.
Do not use smart quotes (""''). Use only regular quotes ("").
Do not add trailing commas.`;

        userPrompt = `Translate the following Chinese segments with pinyin:
${JSON.stringify(segments, null, 2)}

Return your response as a JSON array in the format:

[
  {
    "original": "cleaned_chinese",
    "pinyin": "pinyin",
    "translation": "korean"
  }
]

REQUIREMENTS:
- Return EXACTLY the same number of objects as input segments
- Do NOT merge multiple segments into one
- Return ONLY valid JSON array, no markdown code blocks
- Use only regular quotes (""), not smart quotes
- No trailing commas`;
    }

    console.log(`🚀 OpenAI API 호출 시작 (모델: gpt-4o, 모드: ${mode})`);

    // Promise.race()를 사용한 타임아웃 구현
    const apiCall = openai.chat.completions.create({
      model: "gpt-4o", // 모든 모드에서 정확한 번역을 위해 gpt-4o 사용
      messages: [
        {role: "system", content: systemPrompt},
        {role: "user", content: userPrompt},
      ],
      temperature: 0,
      max_tokens: 2000,
      stream: false,
    });

    const timeout = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error("OpenAI API 타임아웃 (30초)"));
      }, 30000);
    });

    const response = await Promise.race([apiCall, timeout]);
    console.log(`✅ OpenAI API 응답 받음`);

    const content = (response.choices[0] &&
                    response.choices[0].message &&
                    response.choices[0].message.content) || "[]";
    console.log(
        `📄 OpenAI 응답 내용 (처음 200자): "${content.substring(0, 200)}..."`,
    );

    try {
      // OpenAI API 응답에서 마크다운 코드블록 제거 및 정리
      let cleanContent = content;
      
      // 마크다운 코드블록 제거
      if (cleanContent.startsWith("```json")) {
        cleanContent = cleanContent.replace(/^```json\s*/, "").replace(/```$/, "");
      } else if (cleanContent.startsWith("```")) {
        cleanContent = cleanContent.replace(/^```\s*/, "").replace(/```$/, "");
      }
      
      // 추가 정리 작업
      cleanContent = cleanContent.trim();
      
      // 잘못된 따옴표 수정 (smart quotes → regular quotes)
      cleanContent = cleanContent.replace(/[""]/g, '"');
      cleanContent = cleanContent.replace(/['']/g, "'");
      
      // 후행 쉼표 제거 (JSON에서 허용되지 않음)
      cleanContent = cleanContent.replace(/,(\s*[}\]])/g, '$1');
      
      // 줄바꿈과 불필요한 공백 정리
      cleanContent = cleanContent.replace(/\n\s*\n/g, '\n');
      
      console.log(`🔧 코드블록 제거 후: "${cleanContent.substring(0, 100)}..."`);

      // JSON 파싱 시도
      let batchResults;
      try {
        batchResults = JSON.parse(cleanContent);
      } catch (firstParseError) {
        console.log(`⚠️ 첫 번째 JSON 파싱 실패, 추가 정리 시도: ${firstParseError.message}`);
        
        // 더 적극적인 정리 시도
        let fallbackContent = cleanContent;
        
        // 불완전한 객체/배열 구조 수정 시도
        if (!fallbackContent.startsWith('[') && !fallbackContent.startsWith('{')) {
          // JSON이 배열이나 객체로 시작하지 않는 경우, 첫 번째 [ 또는 { 찾기
          const firstBracket = Math.min(
            fallbackContent.indexOf('[') >= 0 ? fallbackContent.indexOf('[') : Infinity,
            fallbackContent.indexOf('{') >= 0 ? fallbackContent.indexOf('{') : Infinity
          );
          if (firstBracket < Infinity) {
            fallbackContent = fallbackContent.substring(firstBracket);
          }
        }
        
        // 불완전한 JSON 끝 처리
        if (!fallbackContent.endsWith(']') && !fallbackContent.endsWith('}')) {
          const lastBracket = Math.max(
            fallbackContent.lastIndexOf(']'),
            fallbackContent.lastIndexOf('}')
          );
          if (lastBracket >= 0) {
            fallbackContent = fallbackContent.substring(0, lastBracket + 1);
          }
        }
        
        try {
          batchResults = JSON.parse(fallbackContent);
          console.log(`✅ 두 번째 시도로 JSON 파싱 성공`);
        } catch (secondParseError) {
          console.error(`❌ 두 번째 JSON 파싱도 실패: ${secondParseError.message}`);
          console.error(`❌ 정리된 내용: "${fallbackContent}"`);
          throw new Error(`JSON 파싱 실패: ${firstParseError.message}`);
        }
      }
      
      console.log(`✅ JSON 파싱 성공: ${batchResults.length}개 결과`);

      if (mode === "paragraph") {
        // 📚 Paragraph 모드 결과 처리
        const units = batchResults.map((result, index) => ({
          originalText: result.original || "",
          translatedText: result.translation || "",
          type: result.type || "unknown",
          sourceLanguage: "zh-CN",
          targetLanguage: targetLanguage,
          // paragraph 모드에서는 병음 없음
          pinyin: "",
        }));

        return {
          units: units,
          fullOriginalText: units.map((u) => u.originalText).join(""),
          fullTranslatedText: units.map((u) => u.translatedText).join(""),
          mode: "paragraph",
        };
      } else {
        // 🔤 Segment 모드 결과 처리
        let units;
        
        if (useDifferentialUpdate) {
          // 📦 Differential Update: 인덱스 기반 응답 (원문 제외)
          units = batchResults.map((result, index) => ({
            index: startIndex + index,           // ✅ 전역 인덱스
            translation: result.translation || "[번역 실패]",
            pinyin: result.pinyin || "",
            sourceLanguage: "zh-CN",
            targetLanguage: targetLanguage,
            // originalText 필드 제거 (클라이언트에 이미 있음)
          }));
          
          console.log(`📦 [Differential Update] 응답 생성: ${units.length}개 유닛 (인덱스 ${startIndex}-${startIndex + units.length - 1})`);
          
          return {
            units: units,
            mode: "differential", // ✅ 클라이언트 감지용
            useDifferentialUpdate: true,
          };
        } else {
          // 🔄 기존 방식: 전체 데이터 응답
          units = batchResults.map((result, index) => ({
            originalText: result.original || segments[index] || "",
            translatedText: result.translation || "[번역 실패]",
            pinyin: result.pinyin || "",
            sourceLanguage: "zh-CN",
            targetLanguage: targetLanguage,
          }));

          return {
            units: units,
            fullOriginalText: units.map((u) => u.originalText).join(""),
            fullTranslatedText: units.map((u) => u.translatedText).join(""),
            mode: "full", // ✅ 클라이언트 감지용
          };
        }
      }
    } catch (parseError) {
      console.error("❌ JSON 파싱 최종 실패:", parseError);
      console.error("❌ 원본 내용:", content);
      console.error("❌ 정리된 내용:", cleanContent);

      // 실패시 폴백 처리
      return createFallbackResult(segments, "[파싱 실패]", targetLanguage, mode);
    }
  } catch (apiError) {
    console.error("❌ OpenAI API 호출 실패:", apiError);

    // API 호출 실패시 폴백 처리
    return createFallbackResult(segments, "[API 호출 실패]", targetLanguage, mode);
  }
}



/**
 * 최적화된 배치 번역 처리 (제한된 병렬 처리)
 * @param {Array} segments 번역할 세그먼트 배열
 * @param {string} sourceLanguage 소스 언어
 * @param {string} targetLanguage 타겟 언어
 * @param {boolean} needPinyin 병음 필요 여부
 * @param {string} mode 처리 모드 ('segment' | 'paragraph')
 * @return {Object} 번역 결과
 */
async function optimizedBatchTranslateSegments(
    segments, sourceLanguage, targetLanguage, needPinyin, mode = "segment",
) {
  console.log(`🔥 [DEBUG] optimizedBatchTranslateSegments 함수 호출됨! (모드: ${mode})`);
  console.log(`🔥 [DEBUG] segments 개수: ${segments ? segments.length : 0}`);

  if (!segments || segments.length === 0) {
    return {units: [], fullOriginalText: "", fullTranslatedText: ""};
  }

  // 더 작은 청크 크기로 변경 (빠른 응답)
  const CHUNK_SIZE = 3;
  const chunks = splitIntoChunks(segments, CHUNK_SIZE);

  console.log(
      `🚀 [최적화] Processing ${chunks.length} chunks of ${CHUNK_SIZE} segments each (모드: ${mode})`,
  );

  const allUnits = [];
  let fullOriginalText = "";
  let fullTranslatedText = "";

  // 제한된 병렬 처리 (최대 2개 동시)
  const MAX_CONCURRENT = 2;

  const processChunk = async (chunk, index) => {
    console.log(`🔄 Processing chunk ${index + 1}/${chunks.length} (모드: ${mode})`);

    try {
      const chunkResult = await translateChunk(chunk, targetLanguage, needPinyin, mode);
      return {success: true, result: chunkResult, index};
    } catch (error) {
      console.error(`❌ Chunk ${index + 1} failed:`, error);
      return {
        success: false,
        error,
        index,
        fallback: chunk.map((segment) =>
          createFallbackUnit(segment, "", targetLanguage, mode),
        ),
      };
    }
  };

  // 병렬 처리 실행
  const results = [];
  for (let i = 0; i < chunks.length; i += MAX_CONCURRENT) {
    const batchPromises = [];

    for (let j = 0; j < MAX_CONCURRENT && i + j < chunks.length; j++) {
      batchPromises.push(processChunk(chunks[i + j], i + j));
    }

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // 다음 배치 전 짧은 지연 (API 안정성)
    if (i + MAX_CONCURRENT < chunks.length) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  // 결과 순서대로 정렬 및 조합
  results.sort((a, b) => a.index - b.index);

  for (const result of results) {
    if (result.success) {
      allUnits.push(...result.result.units);
      fullOriginalText += result.result.fullOriginalText;
      fullTranslatedText += result.result.fullTranslatedText;
    } else {
      allUnits.push(...result.fallback);
      fullOriginalText += result.fallback.map((u) => u.originalText).join("");
    }
  }

  return {
    units: allUnits,
    fullOriginalText: fullOriginalText,
    fullTranslatedText: fullTranslatedText,
    mode: mode,
    sourceLanguage: sourceLanguage,
    targetLanguage: targetLanguage,
  };
}

// ===========================================
// 유틸리티 함수들
// ===========================================

/**
 * 폴백 단위 생성
 * @param {string} segment 원본 세그먼트
 * @param {string} translatedText 번역 텍스트
 * @param {string} targetLanguage 타겟 언어
 * @param {string} mode 처리 모드
 * @return {Object} 폴백 단위
 */
function createFallbackUnit(segment, translatedText, targetLanguage, mode = "segment") {
  return {
    originalText: segment,
    translatedText: translatedText,
    pinyin: "",
    type: mode === "paragraph" ? "unknown" : undefined,
    sourceLanguage: "zh-CN",
    targetLanguage: targetLanguage,
  };
}

/**
 * 폴백 결과 생성
 * @param {Array} segments 원본 세그먼트 배열
 * @param {string} fallbackMessage 폴백 메시지
 * @param {string} targetLanguage 타겟 언어
 * @param {string} mode 처리 모드
 * @return {Object} 폴백 결과
 */
function createFallbackResult(segments, fallbackMessage, targetLanguage, mode = "segment") {
  const units = segments.map((segment) =>
    createFallbackUnit(
        segment,
      mode === "paragraph" ? "" : fallbackMessage,
      targetLanguage,
      mode,
    ),
  );

  return {
    units: units,
    fullOriginalText: segments.join(""),
    fullTranslatedText: mode === "paragraph" ? "" : fallbackMessage,
    mode: mode,
  };
}

/**
 * 배열을 청크로 분할
 * @param {Array} array 분할할 배열
 * @param {number} chunkSize 청크 크기
 * @return {Array} 청크 배열
 */
function splitIntoChunks(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * 문단 모드용 스마트 분할 함수
 * 긴 텍스트를 의미 있는 단위로 분할하여 병렬 처리 가능하게 함
 */
function smartSplitForParagraphMode(fullText) {
  if (!fullText || fullText.length < 300) {
    // 1000자 미만은 분할하지 않음 (더 큰 청크 허용)
    return [fullText];
  }
  
  console.log(`🔄 [스마트분할] 텍스트 길이: ${fullText.length}자`);
  
  // 1. 연속된 줄바꿈으로 문단 구분 (가장 확실한 구분점)
  let chunks = fullText.split(/\n\s*\n/)
    .map(chunk => chunk.trim())
    .filter(chunk => chunk.length > 0);
  
  console.log(`📄 [스마트분할] 1단계 (문단구분): ${chunks.length}개`);
  
  // 2. 너무 긴 청크는 추가 분할
  const MAX_CHUNK_SIZE = 200; // 800자 이상이면 분할 (더 큰 청크 허용)
  const finalChunks = [];
  
  for (const chunk of chunks) {
    if (chunk.length <= MAX_CHUNK_SIZE) {
      finalChunks.push(chunk);
    } else {
      // 긴 청크를 문장 단위로 분할
      const sentences = chunk.split(/[。！？.!?]/)
        .map(s => s.trim())
        .filter(s => s.length > 0);
      
      let currentChunk = '';
      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length > MAX_CHUNK_SIZE && currentChunk.length > 0) {
          finalChunks.push(currentChunk.trim());
          currentChunk = sentence;
        } else {
          currentChunk += (currentChunk ? '。' : '') + sentence;
        }
      }
      
      if (currentChunk.trim()) {
        finalChunks.push(currentChunk.trim());
      }
    }
  }
  
  console.log(`📄 [스마트분할] 최종: ${finalChunks.length}개 청크`);
  finalChunks.forEach((chunk, i) => {
    console.log(`   청크 ${i + 1}: ${chunk.length}자 - "${chunk.substring(0, 30)}..."`);
  });
  
  return finalChunks;
}


// ==========================================
// Cloud Functions - Post-LLM 전용 (번역만)
// functions/index.js
// ==========================================
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onRequest} = require("firebase-functions/v2/https");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const {OpenAI} = require("openai");

initializeApp();

/**
 * DeepSeek 클라이언트 생성 함수
 * @return {OpenAI} DeepSeek 클라이언트 인스턴스 (OpenAI 호환)
 */
function getOpenAIClient() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  
  if (!apiKey) {
    throw new Error('DeepSeek API key not configured');
  }
  
  return new OpenAI({
    apiKey: apiKey,
    baseURL: 'https://api.deepseek.com'
  });
}

// ===========================================
// 텍스트 세그먼트 번역 함수 (Post-LLM만)
// ===========================================
exports.translateSegments = onCall({
  timeoutSeconds: 300,
  memory: "1GiB",
  secrets: ["DEEPSEEK_API_KEY"]  // secret 사용 선언
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "로그인 필요");
  }

  const {
    textSegments,
    sourceLanguage = "zh-CN",
    targetLanguage = "ko",
    needPinyin = true,
    pageId,
    noteId,
  } = request.data;

  console.log(
      `🤖 Translating ${textSegments.length} segments ` +
      `for user: ${request.auth.uid}`,
  );
  console.log(`📄 Page: ${pageId}, Note: ${noteId}`);

  try {
    const startTime = Date.now();

    // 1. 배치 번역 처리 (핵심 최적화!)
    const translationResult = await batchTranslateSegments(
        textSegments,
        sourceLanguage,
        targetLanguage,
        needPinyin,
    );

    // 2. 선택적으로 Firestore 직접 업데이트
    if (pageId) {
      await updatePageWithTranslation(pageId, translationResult);
    }

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
 * 배치 번역 처리 (성능 최적화)
 * @param {Array} segments 번역할 세그먼트 배열
 * @param {string} sourceLanguage 소스 언어
 * @param {string} targetLanguage 타겟 언어
 * @param {boolean} needPinyin 병음 필요 여부
 * @return {Object} 번역 결과
 */
async function batchTranslateSegments(
    segments, sourceLanguage, targetLanguage, needPinyin,
) {
  if (!segments || segments.length === 0) {
    return {units: [], fullOriginalText: "", fullTranslatedText: ""};
  }

  // 세그먼트가 많으면 청크로 나누어 처리 (API 제한 고려)
  const CHUNK_SIZE = 10;
  const chunks = [];

  for (let i = 0; i < segments.length; i += CHUNK_SIZE) {
    chunks.push(segments.slice(i, i + CHUNK_SIZE));
  }

  console.log(
      `📦 Processing ${chunks.length} chunks of ${CHUNK_SIZE} segments each`,
  );

  const allUnits = [];
  let fullOriginalText = "";
  let fullTranslatedText = "";

  // 청크별로 처리
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`🔄 Processing chunk ${i + 1}/${chunks.length}`);

    try {
      const chunkResult = await translateChunk(
          chunk, targetLanguage, needPinyin,
      );

      allUnits.push(...chunkResult.units);
      fullOriginalText += chunkResult.fullOriginalText;
      fullTranslatedText += chunkResult.fullTranslatedText;

      // API 레이트 리밋을 위한 지연
      if (i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (error) {
      console.error(`❌ Chunk ${i + 1} failed:`, error);

      // 실패한 청크는 원본만 유지
      chunk.forEach((segment) => {
        allUnits.push({
          originalText: segment,
          translatedText: "",
          pinyin: "",
          sourceLanguage: sourceLanguage,
          targetLanguage: targetLanguage,
        });
        fullOriginalText += segment;
      });
    }
  }

  return {
    units: allUnits,
    fullOriginalText: fullOriginalText,
    fullTranslatedText: fullTranslatedText,
    mode: "segment",
    sourceLanguage: sourceLanguage,
    targetLanguage: targetLanguage,
  };
}

/**
 * 단일 청크 번역
 * @param {Array} segments 번역할 세그먼트 배열
 * @param {string} targetLanguage 타겟 언어
 * @param {boolean} needPinyin 병음 필요 여부
 * @return {Object} 번역 결과
 */
async function translateChunk(segments, targetLanguage, needPinyin) {
  console.log(`🔄 translateChunk 시작: ${segments.length}개 세그먼트`);
  const firstSegment = segments[0] ? segments[0].substring(0, 50) : "";
  console.log(`📝 첫 번째 세그먼트: "${firstSegment}..."`);

  try {
    const openai = getOpenAIClient(); // 여기서 클라이언트 생성
    console.log(`✅ DeepSeek 클라이언트 생성 완료`);

    const systemPrompt = needPinyin ?
      `You are a Chinese language teacher. ` +
      `Translate Chinese text segments to Korean and provide pinyin.
Return JSON array with exact format: ` +
      `[{"original": "cleaned_chinese", "translation": "korean", ` +
      `"pinyin": "pinyin"}]
Keep the same order as input segments.` :
      `You are a Chinese language teacher. ` +
      `Translate Chinese text segments to Korean.
Return JSON array with exact format: ` +
      `[{"original": "cleaned_chinese", "translation": "korean"}]
Keep the same order as input segments.`;

    const userPrompt =
      `Translate these Chinese text segments to Korean` +
      `${needPinyin ? " with pinyin" : ""}:
${JSON.stringify(segments)}

Return as JSON array maintaining the exact same order.`;

    console.log(`🚀 DeepSeek API 호출 시작 (모델: deepseek-chat)`);

    const response = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        {role: "system", content: systemPrompt},
        {role: "user", content: userPrompt},
      ],
      temperature: 0.1,
      max_tokens: 4000,
    });

    console.log(`✅ Deepseek API 응답 받음`);

    const content = (response.choices[0] &&
                    response.choices[0].message &&
                    response.choices[0].message.content) || "[]";
    console.log(
        `📄 Deepseek 응답 내용 (처음 200자): "${content.substring(0, 200)}..."`,
    );

    try {
      // DeepSeek API 응답에서 마크다운 코드블록 제거
      let cleanContent = content;
      if (cleanContent.startsWith('```json')) {
        cleanContent = cleanContent.replace(/^```json\s*/, '').replace(/```$/, '');
      } else if (cleanContent.startsWith('```')) {
        cleanContent = cleanContent.replace(/^```\s*/, '').replace(/```$/, '');
      }
      cleanContent = cleanContent.trim();

      const batchResults = JSON.parse(cleanContent);
      console.log(`✅ JSON 파싱 성공: ${batchResults.length}개 결과`);

      const units = segments.map((segment, index) => {
        const result = batchResults[index] || {};
        return {
          originalText: result.original || segment,
          translatedText: result.translation || "",
          pinyin: result.pinyin || "",
          sourceLanguage: "zh-CN",
          targetLanguage: targetLanguage,
        };
      });

      console.log(`📊 변환된 units: ${units.length}개`);
      const firstTranslation = units[0] ? units[0].translatedText : "";
      console.log(`📝 첫 번째 unit 번역: "${firstTranslation}"`);

      return {
        units: units,
        fullOriginalText: units.map((u) => u.originalText).join(""),
        fullTranslatedText: units.map((u) => u.translatedText).join(""),
      };
    } catch (parseError) {
      console.error("❌ JSON 파싱 실패:", parseError);
      console.error("❌ 파싱 실패한 내용:", content);

      // 파싱 실패시 폴백 처리
      return {
        units: segments.map((segment) => ({
          originalText: segment,
          translatedText: "[번역 파싱 실패]",
          pinyin: "",
          sourceLanguage: "zh-CN",
          targetLanguage: targetLanguage,
        })),
        fullOriginalText: segments.join(""),
        fullTranslatedText: "[번역 파싱 실패]",
      };
    }
  } catch (apiError) {
    console.error("❌ Deepseek API 호출 실패:", apiError);

    // API 호출 실패시 폴백 처리
    return {
      units: segments.map((segment) => ({
        originalText: segment,
        translatedText: "[API 호출 실패]",
        pinyin: "",
        sourceLanguage: "zh-CN",
        targetLanguage: targetLanguage,
      })),
      fullOriginalText: segments.join(""),
      fullTranslatedText: "[API 호출 실패]",
    };
  }
}

/**
 * Firestore 페이지 업데이트 (선택적)
 * @param {string} pageId 페이지 ID
 * @param {Object} translationResult 번역 결과
 */
async function updatePageWithTranslation(pageId, translationResult) {
  try {
    const db = getFirestore();
    const pageRef = db.collection("pages").doc(pageId);

    await pageRef.update({
      "translatedText": translationResult.fullTranslatedText,
      "pinyin": translationResult.units
          .map((u) => u.pinyin).filter((p) => p).join(" "),
      "processedText.units": translationResult.units.map((unit) => ({
        originalText: unit.originalText,
        translatedText: unit.translatedText,
        pinyin: unit.pinyin,
        sourceLanguage: unit.sourceLanguage,
        targetLanguage: unit.targetLanguage,
      })),
      "processedAt": FieldValue.serverTimestamp(),
      "status": "completed",
    });

    console.log(`✅ Page ${pageId} updated with translation`);
  } catch (error) {
    console.error(`❌ Failed to update page ${pageId}:`, error);
  }
}

// ===========================================
// 상태 확인용 함수
// ===========================================
exports.checkTranslationHealth = onRequest((req, res) => {
  res.json({
    service: "translation-only",
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: "2.0.0",
    capabilities: {
      batchTranslation: true,
      pinyinSupport: true,
      firestoreIntegration: true,
    },
  });
});

// ===========================================
// 테스트용 간단한 함수
// ===========================================
exports.helloWorld = onRequest((request, response) => {
  response.send(
      "Hello from Firebase Functions v2! Translation service is ready.",
  );
});

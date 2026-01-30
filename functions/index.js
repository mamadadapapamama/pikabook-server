// ==========================================
// Cloud Functions - Post-LLM 전용 (Vision + 번역)
// functions/index.js
// ==========================================
const {onRequest, onCall, HttpsError} = require("firebase-functions/v2/https");
const {initializeApp} = require("firebase-admin/app");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getSystemInstruction, GENERATION_CONFIG } = require("./prompts");

initializeApp();

/**
 * Gemini 클라이언트 생성 함수
 */
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("API key not configured");
  }

  return new GoogleGenerativeAI(apiKey);
}

/**
 * 이미지 URL을 Base64로 변환
 */
async function fetchImageAsBase64(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`이미지 다운로드 실패: ${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "image/webp";
  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return { base64, contentType };
}

// ===========================================
// HTTP 스트리밍 번역 함수 (실시간 처리)
// ===========================================
exports.translateSegmentsStream = onRequest({
  timeoutSeconds: 300,
  memory: "1GiB",
  region: "asia-southeast1",
  secrets: ["GEMINI_API_KEY", "OPENAI_API_KEY"],
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
      pageSegments,
      targetLanguage = "ko",
      processingMode,
      excludeHandwriting = false,
    } = req.body;

    if (!pageSegments || pageSegments.length === 0) {
      throw new Error("pageSegments가 없습니다.");
    }

    console.log(`📄 페이지별 처리: ${pageSegments.length}개 페이지`);
    console.log(`🔄 [Processing Mode] ${processingMode}`);
    console.log(`🌐 [Target Language] ${targetLanguage}`);

    const genAI = getGeminiClient();
    // paragraph 모드인 경우 병음 제외 (false), 그 외(segment 등)는 포함 (true)
    const needPinyin = processingMode !== 'TextProcessingMode.paragraph';
    
    // prompts.js의 프롬프트 사용 (Vision 모드)
    const systemInstruction = getSystemInstruction(targetLanguage, needPinyin, excludeHandwriting, true);
    
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.0-flash",
      systemInstruction,
      generationConfig: GENERATION_CONFIG,
    });

    let chunkIndex = 0;
    const totalChunks = pageSegments.length;

    for (const pageInfo of pageSegments) {
      try {
        if (!pageInfo.imageUrl) {
          throw new Error("imageUrl이 없습니다.");
        }

        console.log(`🖼️ [Vision] 페이지 처리 시작: ${pageInfo.pageId}`);
        const { base64, contentType } = await fetchImageAsBase64(pageInfo.imageUrl);

        const imagePart = {
          inlineData: {
            data: base64,
            mimeType: contentType,
          },
        };

        const result = await model.generateContent([imagePart]);
        const response = await result.response;
        const content = response.text();

        const parsed = JSON.parse(content);
        const segments = Array.isArray(parsed?.segments) ? parsed.segments : [];

        // 클라이언트 규격에 맞게 변환 (original, pinyin, translation, type)
        const units = segments.map((segment) => ({
          original: segment.original || "",
          pinyin: segment.pinyin || "",
          translation: segment.translation || "",
          type: segment.type || "sentence",
        }));

        const streamData = {
          chunkIndex,
          totalChunks,
          pageId: pageInfo.pageId,
          units,
          isComplete: chunkIndex === totalChunks - 1,
        };

        res.write(`data: ${JSON.stringify(streamData)}\n\n`);
        console.log(`✅ [스트리밍] 페이지 ${pageInfo.pageId} 전송 완료 (${units.length} 유닛)`);
        chunkIndex++;
      } catch (error) {
        console.error(`❌ [스트리밍] 페이지 ${pageInfo.pageId} 실패:`, error);
        const errorData = {
          chunkIndex,
          pageId: pageInfo.pageId,
          error: error.message,
          isError: true,
        };
        res.write(`data: ${JSON.stringify(errorData)}\n\n`);
        chunkIndex++;
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
// 텍스트 세그먼트 번역 함수 (Text-Only 전용)
// ===========================================
exports.translateSegments = onCall({
  timeoutSeconds: 300,
  memory: "1GiB",
  region: "asia-southeast1",
  secrets: ["GEMINI_API_KEY", "OPENAI_API_KEY"],
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "로그인 필요");
  }

  const {
    textSegments,
    targetLanguage = "ko",
    mode = "segment", // 'segment' | 'paragraph'
  } = request.data;

  if (!textSegments || textSegments.length === 0) {
    return { success: true, translation: { units: [] } };
  }

  try {
    const startTime = Date.now();
    
    // 텍스트 전용 translateChunk 호출
    const needPinyin = mode !== "paragraph";
    const result = await translateChunk(textSegments, targetLanguage, needPinyin, mode);

    const processingTime = Date.now() - startTime;
    console.log(`✅ Translation completed in ${processingTime}ms`);

    return {
      success: true,
      translation: result,
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
 * 텍스트 전용 번역 처리 (Gemini 2.0 Flash + prompts.js 활용)
 */
async function translateChunk(segments, targetLanguage, needPinyin, mode = "segment") {
  console.log(`🔄 translateChunk (Text) 시작: ${segments.length}개 세그먼트 (모드: ${mode})`);

  try {
    const genAI = getGeminiClient();
    // prompts.js의 프롬프트 사용 (Vision 아님)
    const systemInstruction = getSystemInstruction(targetLanguage, needPinyin, false, false);
    
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.0-flash",
      systemInstruction,
      generationConfig: GENERATION_CONFIG,
    });

    const userPrompt = `Process the following Chinese text segments:\n${JSON.stringify(segments, null, 2)}`;

    const result = await model.generateContent(userPrompt);
    const response = await result.response;
    const content = response.text();

    const parsed = JSON.parse(content);
    const batchResults = parsed.segments || [];

    const units = batchResults.map((res) => ({
      originalText: res.original || "",
      translatedText: res.translation || "",
      pinyin: res.pinyin || "",
      type: res.type || "sentence",
      sourceLanguage: "zh-CN",
      targetLanguage: targetLanguage,
    }));

    return {
      units: units,
      fullOriginalText: units.map((u) => u.originalText).join(""),
      fullTranslatedText: units.map((u) => u.translatedText).join(""),
      mode: mode,
    };
  } catch (error) {
    console.error("❌ translateChunk (Text) 실패:", error);
    // 폴백 결과 반환
    return {
      units: segments.map(s => ({
        originalText: s,
        translatedText: "[번역 실패]",
        pinyin: "",
        type: "sentence",
        sourceLanguage: "zh-CN",
        targetLanguage: targetLanguage,
      })),
      mode: mode,
    };
  }
}

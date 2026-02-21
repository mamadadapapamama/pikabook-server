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
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured");
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
exports.translateSegmentsStreamV2 = onRequest({
  timeoutSeconds: 300,
  memory: "1GiB",
  region: "asia-southeast1",
  secrets: ["GEMINI_API_KEY"],
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

    const totalChunks = pageSegments.length;

    // 모든 페이지를 병렬로 Gemini 처리 (최대 동시 실행)
    const processPage = async (pageInfo, index) => {
      try {
        let base64, contentType;

        if (pageInfo.imageBase64) {
          base64 = pageInfo.imageBase64;
          contentType = pageInfo.imageMimeType || "image/webp";
          console.log(`⚡ [Vision] 페이지 처리 시작 (Base64 직접 수신): ${pageInfo.pageId}`);
        } else if (pageInfo.imageUrl) {
          console.log(`🖼️ [Vision] 페이지 처리 시작 (URL 다운로드): ${pageInfo.pageId}`);
          ({ base64, contentType } = await fetchImageAsBase64(pageInfo.imageUrl));
        } else {
          throw new Error("imageUrl 또는 imageBase64가 없습니다.");
        }

        const imagePart = {
          inlineData: { data: base64, mimeType: contentType },
        };

        const streamResult = await model.generateContentStream([imagePart]);
        let content = "";
        for await (const chunk of streamResult.stream) {
          content += chunk.text();
        }

        const parsed = JSON.parse(content);
        const segments = Array.isArray(parsed?.segments) ? parsed.segments : [];

        const units = segments.map((segment) => ({
          original: segment.original || "",
          pinyin: segment.pinyin || "",
          translation: segment.translation || "",
          type: segment.type || "sentence",
        }));

        return {
          chunkIndex: index,
          totalChunks,
          pageId: pageInfo.pageId,
          units,
          isComplete: index === totalChunks - 1,
        };
      } catch (error) {
        console.error(`❌ [스트리밍] 페이지 ${pageInfo.pageId} 실패:`, error);
        return {
          chunkIndex: index,
          pageId: pageInfo.pageId,
          error: error.message,
          isError: true,
        };
      }
    };

    const results = await Promise.all(
      pageSegments.map((pageInfo, index) => processPage(pageInfo, index))
    );

    // 순서대로 클라이언트에 전송
    for (const streamData of results) {
      res.write(`data: ${JSON.stringify(streamData)}\n\n`);
      if (!streamData.isError) {
        console.log(`✅ [스트리밍] 페이지 ${streamData.pageId} 전송 완료 (${streamData.units.length} 유닛)`);
      }
    }

    res.end();
    console.log(`🏁 [스트리밍] 모든 청크 전송 완료 (병렬 처리)`);
  } catch (error) {
    console.error("❌ [스트리밍] 전체 오류:", error);
    res.status(500).json({error: error.message});
  }
});

// ===========================================
// 텍스트 세그먼트 번역 함수 (Text-Only 전용)
// ===========================================
exports.translateSegmentsV2 = onCall({
  timeoutSeconds: 300,
  memory: "1GiB",
  region: "asia-southeast1",
  secrets: ["GEMINI_API_KEY"],
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

    const streamResult = await model.generateContentStream(userPrompt);
    let content = "";
    for await (const chunk of streamResult.stream) {
      content += chunk.text();
    }

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

// ==========================================
// Cloud Functions - Post-LLM 전용 (Vision + 번역)
// functions/index.js
// ==========================================
const {onRequest, onCall, HttpsError} = require("firebase-functions/v2/https");
const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const crypto = require("crypto");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const textToSpeech = require("@google-cloud/text-to-speech");
const { getSystemInstruction, GENERATION_CONFIG } = require("./prompts");

initializeApp();

// ── TTS (Google Cloud Text-to-Speech, Chirp3-HD) ─────────────────
// 서비스 계정(ADC)으로 인증 → API 키 불필요. 앱에 키를 넣지 않는다.
const TTS_LANGUAGE = "cmn-CN";
const TTS_VOICE = "cmn-CN-Chirp3-HD-Achernar"; // 기본 음성. 변경은 이 상수만.
let _ttsClient;
function getTtsClient() {
  if (!_ttsClient) _ttsClient = new textToSpeech.TextToSpeechClient();
  return _ttsClient;
}

/**
 * onRequest 함수용 Firebase ID 토큰 검증.
 * 유효하면 디코딩된 토큰을, 아니면 null을 반환한다.
 */
async function verifyRequestAuth(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer (.+)$/i);
  if (!match) return null;
  try {
    return await getAuth().verifyIdToken(match[1]);
  } catch (err) {
    return null;
  }
}

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

  // 인증 검증: 로그인한 사용자만 (익명 남용/비용 폭탄 차단)
  const decodedToken = await verifyRequestAuth(req);
  if (!decodedToken) {
    res.status(401).json({error: "unauthenticated"});
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

// ===========================================
// TTS 합성 (Google Chirp3-HD) — text + speed → base64 mp3
// 클라이언트는 이 함수를 호출하고, 사용량 집계는 별도(checkUsageQuota).
// ===========================================
exports.ttsSynthesize = onCall({
  timeoutSeconds: 60,
  memory: "256MiB",
  region: "asia-southeast1",
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "로그인 필요");
  }

  const text = String(request.data?.text || "").trim();
  if (!text) {
    throw new HttpsError("invalid-argument", "text가 필요합니다.");
  }
  if (text.length > 2000) {
    throw new HttpsError("invalid-argument", "text가 너무 깁니다(최대 2000자).");
  }

  // 0.25~4.0 범위. 앱: 일반 0.9 / 느린 0.7.
  const speed = Math.min(4.0, Math.max(0.25, Number(request.data?.speed) || 0.9));
  const voice = String(request.data?.voice || TTS_VOICE);

  try {
    const [response] = await getTtsClient().synthesizeSpeech({
      input: { text },
      voice: { languageCode: TTS_LANGUAGE, name: voice },
      audioConfig: { audioEncoding: "MP3", speakingRate: speed },
    });
    const audioBase64 = Buffer.from(response.audioContent).toString("base64");
    return { audioBase64 };
  } catch (error) {
    console.error("❌ TTS synthesis error:", error);
    throw new HttpsError("internal", `TTS 합성 실패: ${error.message}`);
  }
});

// ===========================================
// iFLYTEK 발음평가(ISE) 인증 — 서명된 WebSocket URL + appId 발급
// 비밀값(apiKey/apiSecret)은 서버에만. 앱은 받은 URL로 iFLYTEK에 직접 스트리밍.
// ===========================================
const IFLYTEK_HOST = "ise-api-sg.xf-yun.com";
const IFLYTEK_PATH = "/v2/ise";

exports.iflytekIseAuth = onCall({
  timeoutSeconds: 30,
  memory: "256MiB",
  region: "asia-southeast1",
  secrets: ["IFLYTEK_APP_ID", "IFLYTEK_API_KEY", "IFLYTEK_API_SECRET"],
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "로그인 필요");
  }

  const appId = process.env.IFLYTEK_APP_ID;
  const apiKey = process.env.IFLYTEK_API_KEY;
  const apiSecret = process.env.IFLYTEK_API_SECRET;
  if (!appId || !apiKey || !apiSecret) {
    throw new HttpsError("failed-precondition", "iFLYTEK 자격증명이 설정되지 않았습니다.");
  }

  // RFC1123 GMT (Dart HttpDate.format와 동일 포맷)
  const date = new Date().toUTCString();
  const signatureOrigin =
    `host: ${IFLYTEK_HOST}\n` +
    `date: ${date}\n` +
    `GET ${IFLYTEK_PATH} HTTP/1.1`;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signatureOrigin)
    .digest("base64");
  const authorizationOrigin =
    `api_key="${apiKey}", algorithm="hmac-sha256", ` +
    `headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin).toString("base64");

  const params = new URLSearchParams({
    authorization,
    date,
    host: IFLYTEK_HOST,
  });
  const wsUrl = `wss://${IFLYTEK_HOST}${IFLYTEK_PATH}?${params.toString()}`;

  return { wsUrl, appId };
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

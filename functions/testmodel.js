const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const dotenv = require("dotenv");
const path = require("path");

// .env 파일 로드
dotenv.config({ path: path.join(__dirname, ".env") });

async function runStreamingOcrTest() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("❌ GEMINI_API_KEY가 설정되지 않았습니다.");
    return;
  }

  const targetLanguage = "Korean";
  const testImageDir = path.join(__dirname, "optimized_webp");
  
  if (!fs.existsSync(testImageDir)) {
    console.error(`❌ 테스트 이미지 폴더를 찾을 수 없습니다: ${testImageDir}`);
    return;
  }

  // 폴더 내 첫 번째 이미지 파일 선택
  const files = fs.readdirSync(testImageDir)
    .filter(file => /\.(webp|jpg|jpeg|png)$/i.test(file))
    .sort(); 
  
  if (files.length === 0) {
    console.error(`❌ ${testImageDir} 폴더 내에 이미지 파일이 없습니다.`);
    return;
  }

  const file = files[0]; // 단일 파일만 처리
  const filePath = path.join(testImageDir, file);
  console.log(`🚀 분석 시작: ${file} (언어: ${targetLanguage})`);

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    
    const systemInstruction = `
      ROLE:
      Chinese Language Teacher & Expert Translator
      Extract and process Chinese text from images into structured JSON.

      PROCESS & RULES:
      1. OCR & Segmentation: Extract Hanzi, numbers, and punctuation. Divide into semantic units (sentences).
         - Divide introductory phrases from dialogues (e.g., "A说：" and "“...”").
         - Remove line breaks and extra spaces.
      2. Pinyin: Accurate pinyin with tone marks. Use context-aware pinyin for polyphones (多音字).
      3. Translation: Natural ${targetLanguage} translation. Prioritize context over literal meaning (e.g., idioms, social media terms).

      OUTPUT FORMAT(JSON):
      {
        "segments": [
          {
            "original": "Hanzi_with_punctuation",
            "pinyin": "pinyin_with_tones",
            "translation": "translated_text"
          }
        ]
      }
      CONSTRAINTS:  
      - No Pinyin from the image; only Hanzi.
      - Natural, consistent tone (e.g., friendly for children's stories).
      - Return ONLY the JSON object.
    `;

    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.0-flash",
      systemInstruction: systemInstruction,
      generationConfig: { 
        responseMimeType: "application/json",
        temperature: 0 
      }
    });

    const mimeType = file.toLowerCase().endsWith(".webp") ? "image/webp" : "image/jpeg";
    const imagePart = {
      inlineData: {
        data: fs.readFileSync(filePath).toString("base64"),
        mimeType: mimeType
      }
    };

    const startTime = Date.now();
    console.log("📡 Gemini API 스트리밍 호출 중...");

    const result = await model.generateContentStream([imagePart]);

    let pageContent = "";
    let usageMetadata = null;

    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      pageContent += chunkText;
      if (chunk.usageMetadata) {
        usageMetadata = chunk.usageMetadata;
      }
      process.stdout.write("."); 
    }

    const duration = (Date.now() - startTime) / 1000;
    console.log(`\n✅ 분석 완료! (${duration}초)`);

    try {
      const parsed = JSON.parse(pageContent);
      console.log("\n=== 결과 데이터 ===");
      console.log(JSON.stringify(parsed, null, 2));

      if (usageMetadata) {
        console.log(`\n📊 API 사용량:`);
        console.log(`   - 프롬프트 토큰: ${usageMetadata.promptTokenCount}`);
        console.log(`   - 응답 토큰: ${usageMetadata.candidatesTokenCount}`);
        console.log(`   - 총 토큰: ${usageMetadata.totalTokenCount}`);
      }
    } catch (e) {
      console.error("\n❌ JSON 파싱 에러:", e.message);
      console.log("원본 내용:", pageContent);
    }

  } catch (error) {
    console.error("\n❌ 에러 발생:", error.message);
  }
}

runStreamingOcrTest();

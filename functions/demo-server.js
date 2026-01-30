const express = require("express");
const multer = require("multer");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const dotenv = require("dotenv");
const path = require("path");
const { getSystemInstruction, GENERATION_CONFIG } = require("./prompts");

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static(path.join(__dirname, "public")));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.post("/analyze", upload.single("image"), async (req, res) => {
  try {
    const { language, excludeHandwriting } = req.body;
    const imageFile = req.file;

    if (!imageFile) return res.status(400).json({ error: "이미지 없음" });

    // 분리된 프롬프트 로직 사용
    const systemInstruction = getSystemInstruction(language, excludeHandwriting === "true");

    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.0-flash",
      systemInstruction: systemInstruction,
      generationConfig: GENERATION_CONFIG
    });

    const imagePart = {
      inlineData: {
        data: imageFile.buffer.toString("base64"),
        mimeType: imageFile.mimetype
      }
    };

    console.log(`🚀 Web Demo 분석: ${language}, 손글씨제외=${excludeHandwriting}`);
    const result = await model.generateContent([imagePart]);
    const response = await result.response;
    
    res.json(JSON.parse(response.text()));
  } catch (error) {
    console.error("❌ 서버 에러:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🌟 데모 서버 실행 중: http://localhost:${PORT}`);
});

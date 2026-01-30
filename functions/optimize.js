const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

// 설정값
const CONFIG = {
  maxDimension: 1600,
  quality: 80,
  inputDir: path.join(__dirname, "input_images"),   // 변환할 원본 이미지 폴더
  outputDir: path.join(__dirname, "optimized_webp") // 변환된 결과물 폴더
};

async function optimizeImages() {
  // 폴더가 없으면 생성
  if (!fs.existsSync(CONFIG.inputDir)) fs.mkdirSync(CONFIG.inputDir);
  if (!fs.existsSync(CONFIG.outputDir)) fs.mkdirSync(CONFIG.outputDir);

  const files = fs.readdirSync(CONFIG.inputDir).filter(file => 
    /\.(jpg|jpeg|png|heic|webp)$/i.test(file)
  );

  if (files.length === 0) {
    console.log(`
    ℹ️ 변환할 이미지가 없습니다. 
    'functions/input_images' 폴더에 이미지(png, heic, jpg 등)를 넣어주세요.
    `);
    return;
  }

  console.log(`🚀 총 ${files.length}개의 이미지 최적화 시작...`);

  for (const file of files) {
    const inputPath = path.join(CONFIG.inputDir, file);
    const outputFileName = path.parse(file).name + ".webp";
    const outputPath = path.join(CONFIG.outputDir, outputFileName);

    try {
      // { failOn: 'none' } 옵션을 추가하여 HEIC 파싱 중 발생하는 비치명적 오류를 무시합니다.
      await sharp(inputPath, { failOn: 'none' })
        .rotate() 
        .resize({
          width: CONFIG.maxDimension,
          height: CONFIG.maxDimension,
          fit: sharp.fit.inside,
          withoutEnlargement: true
        })
        .webp({ quality: CONFIG.quality })
        .toFile(outputPath);

      console.log(`✅ 성공: ${file} -> ${outputFileName}`);
    } catch (error) {
      console.error(`❌ 실패: ${file} - ${error.message}`);
    }
  }

  console.log(`
  ✨ 모든 작업이 완료되었습니다!
  📁 결과물 위치: ${CONFIG.outputDir}
  `);
}

optimizeImages();

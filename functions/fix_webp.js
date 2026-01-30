const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const TARGET_DIR = path.join(__dirname, "optimized_webp");
const CONFIG = {
  maxDimension: 1600,
  quality: 80
};

async function fixWebpFiles() {
  if (!fs.existsSync(TARGET_DIR)) {
    console.error(`❌ 폴더를 찾을 수 없습니다: ${TARGET_DIR}`);
    return;
  }

  const files = fs.readdirSync(TARGET_DIR).filter(file => 
    /\.(webp)$/i.test(file)
  );

  if (files.length === 0) {
    console.log("ℹ️ 처리할 .webp 파일이 없습니다.");
    return;
  }

  console.log(`🚀 ${files.length}개의 WebP 파일 재최적화 시작...`);

  for (const file of files) {
    const filePath = path.join(TARGET_DIR, file);
    
    try {
      // 1. 이미지 메타데이터 확인 (크기 체크용)
      const image = sharp(filePath);
      const metadata = await image.metadata();

      // 2. 최적화 처리 (메모리 버퍼로 읽은 뒤 다시 쓰기)
      const buffer = await image
        .resize({
          width: CONFIG.maxDimension,
          height: CONFIG.maxDimension,
          fit: sharp.fit.inside,
          withoutEnlargement: true // 이미 1600보다 작으면 키우지 않음
        })
        .webp({ quality: CONFIG.quality })
        .toBuffer();

      // 3. 기존 파일 덮어쓰기
      fs.writeFileSync(filePath, buffer);

      console.log(`✅ 최적화 완료: ${file} (기존 크기: ${metadata.width}x${metadata.height})`);
    } catch (error) {
      console.error(`❌ 실패: ${file} - ${error.message}`);
    }
  }

  console.log("\n✨ 모든 WebP 파일이 1600px / Quality 80으로 재설정되었습니다.");
}

fixWebpFiles();

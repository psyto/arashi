const puppeteer = require("puppeteer");
const path = require("path");
const { execSync } = require("child_process");

const TOTAL_SLIDES = 8;
const SLIDE_DURATION = 8;
const TOTAL_DURATION = TOTAL_SLIDES * SLIDE_DURATION + 2;
const FPS = 30;
const OUTPUT_DIR = path.join(__dirname, "frames");
const OUTPUT_VIDEO = path.join(__dirname, "arashi-demo.mp4");

async function main() {
  console.log("⛈️  Recording Arashi demo video...\n");

  execSync(`rm -rf "${OUTPUT_DIR}" && mkdir -p "${OUTPUT_DIR}"`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--window-size=1920,1080"],
    defaultViewport: { width: 1920, height: 1080 },
  });

  const page = await browser.newPage();
  await page.goto(`file://${path.join(__dirname, "presentation.html")}`, {
    waitUntil: "domcontentloaded",
  });

  const totalFrames = TOTAL_DURATION * FPS;
  const intervalMs = 1000 / FPS;

  console.log(`Capturing ${totalFrames} frames at ${FPS}fps...`);

  for (let i = 0; i < totalFrames; i++) {
    const frameNum = String(i).padStart(6, "0");
    await page.screenshot({
      path: path.join(OUTPUT_DIR, `frame_${frameNum}.png`),
      type: "png",
    });

    if (i % (FPS * 5) === 0) {
      const sec = Math.floor(i / FPS);
      console.log(`  ${sec}s / ${TOTAL_DURATION}s (${Math.floor((i / totalFrames) * 100)}%)`);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  await browser.close();
  console.log(`\nFrames captured. Encoding video...`);

  execSync(
    `ffmpeg -y -framerate ${FPS} -i "${OUTPUT_DIR}/frame_%06d.png" ` +
      `-c:v libx264 -pix_fmt yuv420p -crf 18 -preset medium ` +
      `"${OUTPUT_VIDEO}"`,
    { stdio: "inherit" }
  );

  execSync(`rm -rf "${OUTPUT_DIR}"`);

  console.log(`\nDone! Video saved to: ${OUTPUT_VIDEO}`);
  console.log(`Duration: ~${TOTAL_DURATION}s`);
  console.log(`\nNext: Add voiceover using QuickTime or any video editor.`);
}

main().catch(console.error);

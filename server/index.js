// index.js
import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const isLinux = process.platform === "linux";

let launchBrowser;
if (isLinux) {
  const chromium = (await import("@sparticuz/chromium")).default;
  const puppeteerCore = (await import("puppeteer-core")).default;

  launchBrowser = async () => {
    const executablePath = await chromium.executablePath();
    return puppeteerCore.launch({
      headless: true,
      args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: chromium.defaultViewport,
      executablePath,
      ignoreHTTPSErrors: true
    });
  };
} else {
  const puppeteer = (await import("puppeteer")).default;
  launchBrowser = async () => puppeteer.launch({ headless: true });
}

async function extractFromFrame(frame) {
  let v = await frame.evaluate(() => {
    // @ts-ignore
    return typeof window.clicktrackedAd_js !== "undefined" ? window.clicktrackedAd_js : null;
  }).catch(() => n

cd ~/Desktop/clicktrackedad-scraper/server

cat > index.js << 'EOF'
// index.js
import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Detecteer omgeving: Render/Linux → puppeteer-core + @sparticuz/chromium
// Lokaal (macOS/Windows) → gewone puppeteer.
const isLinux = process.platform === "linux";

let launchBrowser;
if (isLinux) {
  const chromium = (await import("@sparticuz/chromium")).default;
  const puppeteerCore = (await import("puppeteer-core")).default;

  launchBrowser = async () => {
    const executablePath = await chromium.executablePath();
    return puppeteerCore.launch({
      headless: true,
      args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: chromium.defaultViewport,
      executablePath,
      ignoreHTTPSErrors: true
    });
  };
} else {
  const puppeteer = (await import("puppeteer")).default;
  launchBrowser = async () => puppeteer.launch({ headless: true });
}

// ---------- helpers ----------
async function extractFromFrame(frame) {
  // 1) direct window var
  let v = await frame.evaluate(() => {
    // @ts-ignore
    return typeof window.clicktrackedAd_js !== "undefined" ? window.clicktrackedAd_js : null;
  }).catch(() => null);

  // 2) storage
  if (!v) {
    v = await frame.evaluate(() =>
      localStorage.getItem("clicktrackedAd_js") ||
      sessionStorage.getItem("clicktrackedAd_js") ||
      null
    ).catch(() => null);
  }

  // 3) inline scripts
  if (!v) {
    v = await frame.evaluate(() => {
      const re = /\bclicktrackedAd_js\b\s*[:=]\s*["']([^"']+)["']/i;
      const blocks = Array.from(document.scripts).map(s => s.textContent || "");
      const all = blocks.join("\n");
      const m = all.match(re);
      return m ? m[1] : null;
    }).catch(() => null);
  }

  // 4) volledige HTML scannen
  if (!v) {
    const html = await frame.evaluate(() => document.documentElement?.outerHTML || "")
      .catch(() => "");
    const m = html && html.match(/\bclicktrackedAd_js\b\s*[:=]\s*["']([^"']+)["']/i);
    if (m) v = m[1];
  }

  return v || null;
}

async function extractClickTrackedAd(page) {
  // Sommige sites doen A/B of bot-gating; deze headers helpen
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "referer": "https://www.google.com/"
  });

  // Wachtmomenten worden verderop gedaan
  let value = await extractFromFrame(page.mainFrame());

  // Same-origin iframes
  if (!value) {
    const origin = new URL(page.url()).origin;
    for (const fr of page.frames()) {
      if (fr === page.mainFrame()) continue;
      if (!fr.url()) continue;
      const sameOrigin = fr.url().startsWith(origin);
      if (!sameOrigin) continue;
      value = await extractFromFrame(fr);
      if (value) break;
    }
  }

  // Cross-origin: iframe src los openen
  if (!value) {
    const iframeSrcs = await page.$$eval("iframe", els =>
      els.map(e => e.getAttribute("src")).filter(Boolean)
    ).catch(() => []);
    for (const src of iframeSrcs) {
      try {
        const abs = new URL(src, page.url()).href;
        const p2 = await page.browser().newPage();
        await p2.goto(abs, { waitUntil: "domcontentloaded", timeout: 60000 });
        const v2 = await extractFromFrame(p2.mainFrame());
        await p2.close();
        if (v2) { value = v2; break; }
      } catch { /* negeren en volgende proberen */ }
    }
  }

  // Laatste kleine wacht (sommige tags zetten var async)
  if (!value) {
    try {
      await page.waitForFunction(
        () => typeof window.clicktrackedAd_js !== "undefined",
        { timeout: 10000 }
      );
      value = await page.evaluate(() => window.clicktrackedAd_js);
    } catch { /* niks */ }
  }

  return value || null;
}
// ---------- einde helpers ----------

app.get("/", (_req, res) => res.send("OK"));

app.post("/scrape", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "Missing 'url' in body" });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // Eerst snel naar DOM ready; extractor doet verdere waits/openen
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    const value = await extractClickTrackedAd(page);
    res.json({ url, clicktrackedAd_js: value, finalUrl: page.url() });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  } finally {
    if (browser) await browser.close();
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Scraper running on :${port}`));

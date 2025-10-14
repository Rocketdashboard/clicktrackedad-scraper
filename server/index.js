import express from "express";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.send("OK"));

app.post("/scrape", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "Missing 'url' in body" });

  let browser;
  try {
    const executablePath = await chromium.executablePath();

    browser = await puppeteer.launch({
      headless: true,
      args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: chromium.defaultViewport,
      executablePath,
      ignoreHTTPSErrors: true
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // 1) window-var
    let value = await page.evaluate(() =>
      typeof window.clicktrackedAd_js !== "undefined" ? window.clicktrackedAd_js : null
    );

    // 2) storage
    if (!value) {
      value = await page.evaluate(() =>
        localStorage.getItem("clicktrackedAd_js") ||
        sessionStorage.getItem("clicktrackedAd_js") ||
        null
      );
    }

    // 3) inline scripts
    if (!value) {
      value = await page.evaluate(() => {
        const blocks = Array.from(document.scripts).map(s => s.textContent || "");
        const all = blocks.join("\n");
        const m = all.match(/\bclicktrackedAd_js\b\s*[:=]\s*["']([^"']+)["']/i);
        return m ? m[1] : null;
      });
    }

    // 4) korte extra wacht
    if (!value) {
      try {
        await page.waitForFunction(
          () => typeof window.clicktrackedAd_js !== "undefined",
          { timeout: 15000 }
        );
        value = await page.evaluate(() => window.clicktrackedAd_js);
      } catch {}
    }

    res.json({ url, clicktrackedAd_js: value, finalUrl: page.url() });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  } finally {
    if (browser) await browser.close();
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Scraper running on :${port}`));

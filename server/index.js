// index.js (iframe-aware + DOM-marker variant)
import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Linux (Render) => puppeteer-core + @sparticuz/chromium, anders puppeteer
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
      ignoreHTTPSErrors: true,
    });
  };
} else {
  const puppeteer = (await import("puppeteer")).default;
  launchBrowser = async () => puppeteer.launch({ headless: true });
}

// ---- helpers ----
async function extractDomMarker(frame) {
  return frame
    .evaluate(() => {
      const sel = [
        '[class*="clicktrackedAd_js"]',
        '[id*="clicktrackedAd_js"]',
        '[name*="clicktrackedAd_js"]',
        "[data-clicktrackedAd_js]",
        "[data-clicktrackedad_js]",
      ].join(",");

      const el = document.querySelector(sel);
      if (!el) return null;

      // probeer een relevante URL te vinden
      const a = el.closest("a") || el.querySelector("a");
      const href = a?.href || null;

      return {
        href,
        text: (el.textContent || "").trim().slice(0, 200),
        tag: el.tagName?.toLowerCase() || "unknown",
        htmlSnippet: el.outerHTML?.slice(0, 1000) || "",
      };
    })
    .catch(() => null);
}

async function extractFromFrame(frame) {
  // 1) window var
  let v = await frame
    .evaluate(() =>
      typeof window.clicktrackedAd_js !== "undefined"
        ? window.clicktrackedAd_js
        : null
    )
    .catch(() => null);

  // 2) storage
  if (!v)
    v = await frame
      .evaluate(
        () =>
          localStorage.getItem("clicktrackedAd_js") ||
          sessionStorage.getItem("clicktrackedAd_js") ||
          null
      )
      .catch(() => null);

  // 3) inline scripts
  if (!v)
    v = await frame
      .evaluate(() => {
        const re = /\bclicktrackedAd_js\b\s*[:=]\s*["']([^"']+)["']/i;
        const blocks = Array.from(document.scripts).map(
          (s) => s.textContent || ""
        );
        const all = blocks.join("\n");
        const m = all.match(re);
        return m ? m[1] : null;
      })
      .catch(() => null);

  // 4) hele HTML scannen
  if (!v) {
    const html = await frame
      .evaluate(() => document.documentElement?.outerHTML || "")
      .catch(() => "");
    const m =
      html && html.match(/\bclicktrackedAd_js\b\s*[:=]\s*["']([^"']+)["']/i);
    if (m) v = m[1];
  }

  // 5) DOM-marker (class/id/name bevat clicktrackedAd_js)
  if (!v) {
    const marker = await extractDomMarker(frame);
    if (marker) {
      // geef de href terug als 'waarde' als die bestaat, anders 'present'
      v = marker.href || "present";
      // zet details op window zodat de caller die kan ophalen
      try {
        await frame.evaluate((m) => {
          // @ts-ignore
          window.__CTAD_DETAILS__ = m;
        }, marker);
      } catch {}
    }
  }

  return v || null;
}

async function extractClickTrackedAd(page) {
  // headers helpen bij bot-detectie
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    referer: "https://www.google.com/",
  });

  // hoofdframe
  let value = await extractFromFrame(page.mainFrame());

  // same-origin iframes
  if (!value) {
    const origin = new URL(page.url()).origin;
    for (const fr of page.frames()) {
      if (fr === page.mainFrame()) continue;
      if (!fr.url()) continue;
      if (!fr.url().startsWith(origin)) continue;
      value = await extractFromFrame(fr);
      if (value) break;
    }
  }

  // cross-origin iframes: src los openen
  if (!value) {
    const srcs =
      (await page
        .$$eval("iframe", (els) =>
          els.map((e) => e.getAttribute("src")).filter(Boolean)
        )
        .catch(() => [])) || [];
    for (const src of srcs) {
      try {
        const abs = new URL(src, page.url()).href;
        const p2 = await page.browser().newPage();
        await p2.goto(abs, { waitUntil: "domcontentloaded", timeout: 60000 });
        const v2 = await extractFromFrame(p2.mainFrame());

        // dom-marker details vanuit subpage naar mainframe kopiëren
        try {
          const subDetails = await p2.evaluate(
            () => window.__CTAD_DETAILS__ || null
          );
          if (subDetails) {
            await page.evaluate((d) => {
              // @ts-ignore
              window.__CTAD_DETAILS__ = d;
            }, subDetails);
          }
        } catch {}

        await p2.close();
        if (v2) {
          value = v2;
          break;
        }
      } catch {}
    }
  }

  // laatste kleine wacht: soms wordt var async gezet
  if (!value) {
    try {
      await page.waitForFunction(
        () => typeof window.clicktrackedAd_js !== "undefined",
        { timeout: 10000 }
      );
      value = await page.evaluate(() => window.clicktrackedAd_js);
    } catch {}
  }

  return value || null;
}
// ---- end helpers ----

app.get("/", (_req, res) => res.send("OK"));

app.post("/scrape", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "Missing 'url' in body" });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    const value = await extractClickTrackedAd(page);

    // dom-marker details uit mainframe pakken (als gezet)
    let details = null;
    try {
      details = await page.evaluate(() =>
        // @ts-ignore
        typeof window.__CTAD_DETAILS__ !== "undefined"
          ? // @ts-ignore
            window.__CTAD_DETAILS__
          : null
      );
    } catch {}

    res.json({ url, clicktrackedAd_js: value, finalUrl: page.url(), details });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  } finally {
    if (browser) await browser.close();
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Scraper running on :${port}`));

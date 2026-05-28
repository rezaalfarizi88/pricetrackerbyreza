const session = require("express-session");
const bcrypt = require("bcryptjs");
const express = require("express");
const puppeteer = require("puppeteer");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "price-tracker-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    maxAge: 24 * 60 * 60 * 1000 // 1 hari
  }
}));

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.redirect("/login.html");
});

// ============================================================
// KONFIGURASI PRODUK
// Setiap produk bisa punya hingga 15 kompetitor.
// Kolom kompetitor yang tidak diisi akan tampil sebagai "-"
// ============================================================

let trackedProducts = [
  {
    id: 1,
    name: "BORDES ALUMINIUM",
    size: "1000x2000mm",
    thickness: "2mm",
    myPrice: 150000,
    updatedAt: new Date().toISOString(),
    note: "-",
    competitors: [
      { store: "Toko Rival 1", url: "https://www.tokopedia.com/mulinia/expanded-metal-metal-expanda-uk-1-2-x-2-4-m-tipe-1729851830797764411?extParam=src%3Dshop%26whid%3D16825462&aff_unique_id=&channel=others&chain_key=" },
      { store: "Toko Rival 2", url: "https://www.tokopedia.com/mulinia/wiremesh-galvanis-kawat-loket-galvanis-lembaran-panel-galvanis-1-2-m-x-2-4-m-1200-mm-x-2400-mm-1734435682561394491?extParam=src%3Dshop%26whid%3D16825462&aff_unique_id=&channel=others&chain_key=" },
      // tambahkan hingga 15 kompetitor
    ],
  },
  {
    id: 2,
    name: "PLAT ALUMINIUM POLOS",
    size: "1200x2400mm",
    thickness: "3mm",
    myPrice: 250000,
    updatedAt: new Date().toISOString(),
    note: "-",
    competitors: [
      { store: "Toko Rival 1", url: "https://www.tokopedia.com/mulinia/wiremesh-galvanis-kawat-loket-galvanis-lembaran-panel-galvanis-1-2-m-x-2-4-m-1200-mm-x-2400-mm-1734435682561394491?extParam=src%3Dshop%26whid%3D16825462&aff_unique_id=&channel=others&chain_key=" },
    ],
  },
];

const users = [
  {
    username: "Reza",
    password: bcrypt.hashSync("NatusV1ncere23", 10),
    role: "admin"
  },
  {
    username: "pabosbubos",
    password: bcrypt.hashSync("Sl0wbutsur3", 10),
    role: "visitor"
  }
];

// ============================================================
const REFRESH_INTERVAL = 12 * 60 * 60 * 1000; // 12 JAM
const MAX_COMPETITORS  = 15;

let browser        = null;
let scrapeCache    = {};
let lastScrapeTime = null;
let nextScrapeTime = null;

// ── Deteksi Chrome / Chromium ──
function getChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const fs   = require("fs");
  const paths = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/snap/bin/chromium",
    "/usr/local/bin/chromium",
    "/run/current-system/sw/bin/chromium",
  ];
  return paths.find((p) => fs.existsSync(p)) || null;
}

async function initBrowser() {
  if (browser) return;
  const executablePath = getChromePath();
  const opts = {
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
    ],
  };
  if (executablePath) {
    opts.executablePath = executablePath;
    console.log("🔍 Menggunakan Chrome:", executablePath);
  }
  browser = await puppeteer.launch(opts);
  console.log("✅ Browser siap.");
}

async function scrapePrice(url) {
  let page = null;
  try {
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "font", "media"].includes(req.resourceType())) req.abort();
      else req.continue();
    });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await page
      .waitForSelector('[data-testid="lblPDPDetailProductPrice"], .price, [class*="price"]', { timeout: 10000 })
      .catch(() => {});

    const price = await page.evaluate(() => {
      const selectors = [
        '[data-testid="lblPDPDetailProductPrice"]',
        '[class*="ProductPrice"]',
        '[class*="product-price"]',
        ".price",
        '[class*="price"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.innerText || el.textContent;
          const match = text.replace(/\./g, "").match(/\d+/);
          if (match) return parseInt(match[0]);
        }
      }
      return null;
    });
    return price;
  } catch (err) {
    console.error("Scrape error:", url, err.message);
    return null;
  } finally {
    if (page) await page.close();
  }
}

async function scrapeAll() {
  console.log("\n⏳ Mulai scraping semua produk...");
  await initBrowser();

  for (const product of trackedProducts) {
    for (const comp of product.competitors) {
      const key   = `${product.id}_${comp.store}`;
      const price = await scrapePrice(comp.url);
      scrapeCache[key] = {
        price,
        scrapedAt: new Date().toISOString(),
        status: price ? "ok" : "error",
      };
      console.log(
        `  [${product.name}] ${comp.store} → ${price ? "Rp " + price.toLocaleString("id-ID") : "Gagal"}`
      );
    }
  }

  lastScrapeTime = new Date().toISOString();
  nextScrapeTime = new Date(Date.now() + REFRESH_INTERVAL).toISOString();
  console.log("✅ Scraping selesai:", lastScrapeTime);
  console.log("🕐 Scraping berikutnya:", nextScrapeTime);
}

// ============================================================
// MIDDLEWARE AUTH
// ============================================================

function isAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === "admin") {
    return next();
  }
  res.status(403).json({ error: "Akses admin ditolak" });
}

function isLoggedIn(req, res, next) {
  if (req.session.user) {
    return next();
  }
  res.status(401).json({ error: "Harus login" });
}

// ============================================================
// API
// ============================================================

app.get("/api/products", (req, res) => {
  const result = trackedProducts.map((product) => {
    const compSlots = Array.from({ length: MAX_COMPETITORS }, (_, i) => {
      const comp = product.competitors[i];
      if (!comp) return null;
      const key      = `${product.id}_${comp.store}`;
      const cached   = scrapeCache[key] || {};
      const compPrice = cached.price || null;
      const diff      = compPrice !== null ? compPrice - product.myPrice : null;
      const diffPct   = compPrice !== null
        ? (((compPrice - product.myPrice) / product.myPrice) * 100).toFixed(1)
        : null;
      return {
        store: comp.store,
        url: comp.url,
        price: compPrice,
        status: cached.status || "pending",
        scrapedAt: cached.scrapedAt || null,
        diff,
        diffPercent: diffPct,
      };
    });

    return {
      id: product.id,
      name: product.name,
      size: product.size || "-",
      thickness: product.thickness || "-",
      myPrice: product.myPrice,
      updatedAt: product.updatedAt || null,
      note: product.note || "-",
      competitors: compSlots,
    };
  });

  res.json({ products: result, lastScrapeTime, nextScrapeTime, maxCompetitors: MAX_COMPETITORS });
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: "Belum login" });
  }
  res.json(req.session.user);
});

app.get("/api/status", (req, res) => {
  res.json({
    status: "running",
    lastScrapeTime,
    nextScrapeTime,
    totalProducts: trackedProducts.length,
    refreshIntervalHours: REFRESH_INTERVAL / 3600000,
  });
});

app.post("/api/refresh", async (req, res) => {
  res.json({ message: "Scraping dimulai..." });
  scrapeAll();
});

app.post("/api/products", isAdmin, (req, res) => {
  const { name, size, thickness, myPrice, competitors, note } = req.body;
  if (!name || !myPrice) return res.status(400).json({ error: "name dan myPrice wajib diisi" });
  const product = {
    id: Date.now(),
    name,
    size: size || "-",
    thickness: thickness || "-",
    myPrice: parseInt(myPrice),
    updatedAt: new Date().toISOString(),
    note: note || "-",
    competitors: (competitors || []).slice(0, MAX_COMPETITORS),
  };
  trackedProducts.push(product);
  res.json({ message: "Produk ditambahkan", product });
  scrapeAll();
});

app.put("/api/products/:id/price", isAdmin, (req, res) => {
  const productId = parseInt(req.params.id);
  const product = trackedProducts.find(p => p.id === productId);
  if (!product) return res.status(404).json({ error: "Produk tidak ditemukan" });
  const myPrice = parseInt(req.body.myPrice);
  if (isNaN(myPrice)) return res.status(400).json({ error: "Harga tidak valid" });
  product.myPrice = myPrice;
  product.updatedAt = new Date().toISOString();
  res.json({ success: true, message: "Harga berhasil diupdate", myPrice });
});

app.put("/api/products/:id/competitors/:index", isAdmin, (req, res) => {
  const productId = parseInt(req.params.id);
  const compIndex = parseInt(req.params.index);
  const { store, url } = req.body;
  const product = trackedProducts.find(p => p.id === productId);
  if (!product) return res.status(404).json({ error: "Produk tidak ditemukan" });
  if (!product.competitors[compIndex]) return res.status(404).json({ error: "Kompetitor tidak ditemukan" });
  product.competitors[compIndex] = { ...product.competitors[compIndex], store, url };
  const key = `${product.id}_${store}`;
  delete scrapeCache[key];
  res.json({ message: "Kompetitor berhasil diupdate" });
  scrapePrice(url).then(price => {
    scrapeCache[key] = {
      price,
      scrapedAt: new Date().toISOString(),
      status: price ? "ok" : "error"
    };
  });
});

app.put("/api/products/:id/note", (req, res) => {
  const productId = parseInt(req.params.id);
  const { note } = req.body;
  const product = trackedProducts.find(p => p.id === productId);
  if (!product) return res.status(404).json({ error: "Produk tidak ditemukan" });
  product.note = note || "-";
  product.updatedAt = new Date().toISOString();
  res.json({ message: "Keterangan berhasil diperbarui", note: product.note });
});

app.delete("/api/products/:id", isAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  trackedProducts = trackedProducts.filter((p) => p.id !== id);
  res.json({ message: "Produk dihapus" });
});

// =======================================
// LOGIN / LOGOUT
// =======================================

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: "Username salah" });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: "Password salah" });
  req.session.user = { username: user.username, role: user.role };
  res.json({ success: true, role: user.role });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// ============================================================
app.listen(PORT, async () => {
  console.log(`\n🚀 Price Tracker → http://localhost:${PORT}`);
  console.log(`🔄 Auto-refresh setiap 12 jam\n`);
  await initBrowser();
  await scrapeAll();
  setInterval(scrapeAll, REFRESH_INTERVAL);
});

process.on("SIGINT", async () => {
  if (browser) await browser.close();
  process.exit(0);
});

const session = require("express-session");
const bcrypt = require("bcryptjs");
const express = require("express");
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// KONEKSI POSTGRESQL
// ============================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGINT PRIMARY KEY,
      name TEXT NOT NULL,
      size TEXT DEFAULT '-',
      thickness TEXT DEFAULT '-',
      my_price INTEGER NOT NULL,
      updated_at TEXT,
      note TEXT DEFAULT '-',
      competitors JSONB DEFAULT '[]'
    )
  `);

  await pool.query(`
  CREATE TABLE IF NOT EXISTS scrape_cache (
    key TEXT PRIMARY KEY,
    price INTEGER,
    sold TEXT,
    scraped_at TEXT,
    status TEXT
  )
`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")
  `);

  console.log("✅ Tabel products & session siap.");

  const { rowCount } = await pool.query("SELECT 1 FROM products LIMIT 1");
  if (rowCount === 0) {
    const initial = [
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
    for (const p of initial) {
      await pool.query(
        `INSERT INTO products (id, name, size, thickness, my_price, updated_at, note, competitors)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [p.id, p.name, p.size, p.thickness, p.myPrice, p.updatedAt, p.note, JSON.stringify(p.competitors)]
      );
    }
    console.log("📦 Data awal berhasil dimasukkan.");
  }
}

async function getAllProducts() {
  const { rows } = await pool.query("SELECT * FROM products ORDER BY id ASC");
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    size: r.size,
    thickness: r.thickness,
    myPrice: r.my_price,
    updatedAt: r.updated_at,
    note: r.note,
    competitors: r.competitors || [],
  }));
}

async function saveProduct(product) {
  await pool.query(
    `INSERT INTO products (id, name, size, thickness, my_price, updated_at, note, competitors)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       name=$2, size=$3, thickness=$4, my_price=$5,
       updated_at=$6, note=$7, competitors=$8`,
    [
      product.id, product.name, product.size, product.thickness,
      product.myPrice, product.updatedAt, product.note,
      JSON.stringify(product.competitors),
    ]
  );
}

async function deleteProduct(id) {
  await pool.query("DELETE FROM products WHERE id=$1", [id]);
}

// ============================================================
// KONFIGURASI PRODUK (in-memory cache)
// ============================================================

let trackedProducts = [];

// ============================================================

const pgSession = require('connect-pg-simple')(session);

const sessionStore = new pgSession({
  pool: pool,
  tableName: 'session',
  createTableIfMissing: true,
});

sessionStore.on('error', function(error) {
  console.error('Session store error:', error);
});

app.use(express.json());

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || "price-tracker-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, "public")));
app.use('/images', express.static(path.join(__dirname, "images")));

app.get("/", (req, res) => {
  res.redirect("/login.html");
});

const users = [
  {
    username: "Reza",
    password: bcrypt.hashSync("VeniV1d1Vici23", 10),
    role: "admin"
  },
  {
    username: "pabosbubos",
    password: bcrypt.hashSync("Sl0wbutsur3", 10),
    role: "visitor"
  }
];

const REFRESH_INTERVAL = 12 * 60 * 60 * 1000;
const MAX_COMPETITORS  = 15;

let browser        = null;
let scrapeCache    = {};
let lastScrapeTime = null;
let nextScrapeTime = null;
let isScraping     = false;
let scrapeCount    = 0; // ← FIX 2: counter restart browser

function getChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
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
  if (browser) {
    try { await browser.close(); } catch (_) {}
    browser = null;
  }
  const executablePath = getChromePath();
  const opts = {
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
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
    if (!browser || !browser.isConnected()) await initBrowser();
    page = await browser.newPage();

    // ── FIX 4: rotate user agent + headers ──
    const agents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    ];
    await page.setUserAgent(agents[Math.floor(Math.random() * agents.length)]);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    });
    // ── END FIX 4 ──

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      window.chrome = { runtime: {} };
    });
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "font", "media", "stylesheet"].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    const result = await page.evaluate(() => {
      const priceSelectors = [
        '[data-testid="lblPDPDetailProductPrice"]',
        '[class*="ProductPrice"]',
        '[class*="product-price"]',
        ".price",
        '[class*="price"]',
      ];
      let price = null;
      for (const sel of priceSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.innerText || el.textContent;
          const match = text.replace(/\./g, "").match(/\d+/);
          if (match && parseInt(match[0]) > 1000) {
            price = parseInt(match[0]);
            break;
          }
        }
      }

      const soldSelectors = [
        '[data-testid="lblPDPDetailProductSoldCounter"]',
        '[class*="sold"]',
        '[class*="Sold"]',
      ];
      let sold = null;
      for (const sel of soldSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = (el.innerText || el.textContent).trim();
          if (text) { sold = text; break; }
        }
      }

      if (!sold) {
        const all = document.querySelectorAll("*");
        for (const el of all) {
          if (el.children.length === 0) {
            const t = (el.innerText || el.textContent || "").trim().toLowerCase();
            if (t.includes("terjual") && t.length < 40) {
              sold = (el.innerText || el.textContent).trim();
              break;
            }
          }
        }
      }

      return { price, sold };
    });

    return result;
  } catch (err) {
    console.error("Scrape error:", url, err.message);
    if (err.message.includes("Connection closed") || err.message.includes("detached")) {
      browser = null;
    }
    return { price: null, sold: null };
  } finally {
    if (page) {
      try { await page.close(); } catch (_) {}
    }
  }
}

// ============================================================
// CACHE DB
// ============================================================

async function saveCacheDB(key, data) {
  await pool.query(`
    INSERT INTO scrape_cache (key, price, sold, scraped_at, status)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (key) DO UPDATE SET
      price=$2, sold=$3, scraped_at=$4, status=$5
  `, [key, data.price, data.sold, data.scrapedAt, data.status]);
}

async function loadCacheDB() {
  const { rows } = await pool.query('SELECT * FROM scrape_cache');
  rows.forEach(r => {
    scrapeCache[r.key] = {
      price: r.price,
      sold: r.sold,
      scrapedAt: r.scraped_at,
      status: r.status
    };
  });
  console.log(`📦 Cache dimuat: ${rows.length} entri`);
}

// ============================================================

async function scrapeAll() {
  if (isScraping) {
    console.log("⏭️  Scraping sudah berjalan, skip.");
    return;
  }
  isScraping = true;
  scrapeCount = 0; // reset counter tiap sesi scraping baru
  console.log("\n⏳ Mulai scraping semua produk...");
  try {
    await initBrowser();
    const snapshot = [...trackedProducts];
    for (const product of snapshot) {
      for (const comp of product.competitors) {
        const key = `${product.id}_${comp.store}`;
        
        // ── Skip kalau sudah di-scrape dalam 11 jam terakhir ──
        const cached = scrapeCache[key];
        if (cached && cached.scrapedAt) {
          const age = Date.now() - new Date(cached.scrapedAt).getTime();
          if (age < 11 * 60 * 60 * 1000) {
            console.log(`  ⏭ Skip (cache masih fresh): ${comp.store}`);
            continue;
          }
        }

        // Restart browser kalau mati
        if (!browser || !browser.isConnected()) {
          console.log("🔄 Browser mati, restart...");
          await initBrowser();
        }

        const { price, sold } = await scrapePrice(comp.url);
        scrapeCache[key] = {
          price,
          sold,
          scrapedAt: new Date().toISOString(),
          status: price ? "ok" : "error",
        };
        await saveCacheDB(key, scrapeCache[key]);
        console.log(
          `  [${product.name}] ${comp.store} → ${price ? "Rp " + price.toLocaleString("id-ID") : "Gagal"} | ${sold || "-"}`
        );

        // ── FIX 2: restart browser setiap 3 request ──
        scrapeCount++;
        if (scrapeCount % 10 === 0) {
          console.log('🔄 Restart browser...');
          try { await browser.close(); } catch (_) {}
          browser = null;
          await initBrowser();
          await new Promise(r => setTimeout(r, 3000));
        }

        // ── FIX 1: jeda random 4-7 detik ──
        const delay = 6000 + Math.random() * 6000;
        await new Promise(r => setTimeout(r, delay));
      }
    }
    lastScrapeTime = new Date().toISOString();
    nextScrapeTime = new Date(Date.now() + REFRESH_INTERVAL).toISOString();
    console.log("✅ Scraping selesai:", lastScrapeTime);
  } catch (err) {
    console.error("❌ scrapeAll error:", err.message);
  } finally {
    isScraping = false;
  }
}

async function scrapeProduct(product) {
  try {
    await initBrowser();
    for (const comp of product.competitors) {
      const key = `${product.id}_${comp.store}`;
      const { price, sold } = await scrapePrice(comp.url);
      scrapeCache[key] = {
        price,
        sold,
        scrapedAt: new Date().toISOString(),
        status: price ? "ok" : "error",
      };
      await saveCacheDB(key, scrapeCache[key]);
    }
  } catch (err) {
    console.error("❌ scrapeProduct error:", err.message);
  }
}

// ============================================================
// MIDDLEWARE AUTH
// ============================================================

function isAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === "admin") return next();
  res.status(403).json({ error: "Akses admin ditolak" });
}

function isLoggedIn(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ error: "Harus login" });
}

// ============================================================
// API
// ============================================================

app.get("/api/products", async (req, res) => {
  try {
    trackedProducts = await getAllProducts();
    const result = trackedProducts.map((product) => {
      const compSlots = Array.from({ length: MAX_COMPETITORS }, (_, i) => {
        const comp = product.competitors[i];
        if (!comp) return null;
        const key       = `${product.id}_${comp.store}`;
        const cached    = scrapeCache[key] || {};
        const compPrice = cached.price || null;
        const diff = compPrice !== null ? compPrice - product.myPrice : null;
        var diffPct = null;
        if (compPrice !== null) {
          diffPct = (((compPrice - product.myPrice) / product.myPrice) * 100).toFixed(1);
        }
        const compSold = cached.sold || null;
        return {
          store: comp.store,
          url: comp.url,
          price: compPrice,
          sold: compSold,
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Belum login" });
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

app.post("/api/products", isAdmin, async (req, res) => {
  try {
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

    await saveProduct(product);
    trackedProducts.push(product);
    res.json({ message: "Produk ditambahkan", product });
    scrapeProduct(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/products/:id/price", isAdmin, async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const product = trackedProducts.find(p => p.id == productId);
    if (!product) return res.status(404).json({ error: "Produk tidak ditemukan" });
    const myPrice = parseInt(req.body.myPrice);
    if (isNaN(myPrice)) return res.status(400).json({ error: "Harga tidak valid" });
    product.myPrice = myPrice;
    product.updatedAt = new Date().toISOString();
    await saveProduct(product);
    res.json({ success: true, message: "Harga berhasil diupdate", myPrice });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/products/:id/competitors/:index", isAdmin, async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const compIndex = parseInt(req.params.index);
    const { store, url } = req.body;
    const product = trackedProducts.find(p => p.id == productId);
    if (!product) return res.status(404).json({ error: "Produk tidak ditemukan" });
    if (!product.competitors[compIndex]) return res.status(404).json({ error: "Kompetitor tidak ditemukan" });
    product.competitors[compIndex] = { ...product.competitors[compIndex], store, url };
    const key = `${product.id}_${store}`;
    delete scrapeCache[key];
    await saveProduct(product);
    res.json({ message: "Kompetitor berhasil diupdate" });
    scrapePrice(url).then(price => {
      scrapeCache[key] = { price, scrapedAt: new Date().toISOString(), status: price ? "ok" : "error" };
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/products/:id/note", async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const { note } = req.body;
    const product = trackedProducts.find(p => p.id == productId);
    if (!product) return res.status(404).json({ error: "Produk tidak ditemukan" });
    product.note = note || "-";
    product.updatedAt = new Date().toISOString();
    await saveProduct(product);
    res.json({ message: "Keterangan berhasil diperbarui", note: product.note });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/products/:id", isAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await deleteProduct(id);
    trackedProducts = trackedProducts.filter(p => p.id != id);
    res.json({ message: "Produk dihapus" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// LOGIN / LOGOUT
// ============================================================

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: "Username atau password salah" });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: "Username atau password salah" });
  req.session.user = { username: user.username, role: user.role };
  res.json({ success: true, role: user.role });
});

// ============================================================
app.listen(PORT, async () => {
  console.log(`\n🚀 Price Tracker → http://localhost:${PORT}`);
  await initDB();
  trackedProducts = await getAllProducts();
  await loadCacheDB();
  console.log(`📦 Total produk: ${trackedProducts.length}`);
  console.log(`🔄 Auto-refresh setiap 12 jam\n`);
  await initBrowser();
  await scrapeAll();
  setInterval(scrapeAll, REFRESH_INTERVAL);
});

process.on("SIGINT", async () => {
  if (browser) await browser.close();
  process.exit(0);
});

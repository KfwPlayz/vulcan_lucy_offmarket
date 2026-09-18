// 📌 Required Libraries
const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// Small helper that works on every Node/Puppeteer version
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 🔐 Credentials and Constants
const LOGIN_URL = "https://www.vulcan7dialer.com/login";
const CONTACTS_URL = "https://www.vulcan7dialer.com/cm/index#params/dmlld19pZD05ODEzOCZwYWdlPTE=";
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
//const CACHE_FILE = path.join(__dirname, "sent-leads-cache-offmarket.json");

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    protocolTimeout: 180000,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process"
    ]
  });

  const page = await browser.newPage();

  // === CI hardening: timeouts, UA, resource blocking, logs ===
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);

  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 768 });

  await page.setRequestInterception(true);
  page.on("request", req => {
    const type = req.resourceType();
    if (type === "image" || type === "font" || type === "media") req.abort();
    else req.continue();
  });

  page.on("console", msg => console.log("[BROWSER]", msg.type(), msg.text()));
  page.on("pageerror", err => console.log("[PAGEERROR]", err));
  page.on("requestfailed", req => console.log("[REQ FAILED]", req.url(), req.failure()?.errorText));
  // === end CI hardening ===

  try {
    // 🔐 Log in to Vulcan7
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector('input[name="email"], #email, input[name="username"]', { timeout: 120000 });
    await page.waitForSelector('input[name="password"], #password', { timeout: 120000 });

    const emailSel = (await page.$('input[name="email"]')) ? 'input[name="email"]'
                     : (await page.$('#email')) ? '#email'
                     : 'input[name="username"]';
    const passSel  = (await page.$('input[name="password"]')) ? 'input[name="password"]' : '#password';

    await page.type(emailSel, EMAIL, { delay: 20 });
    await page.type(passSel, PASSWORD, { delay: 20 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 120000 }),
      page.click('button[type="submit"], .login-button')
    ]);

    // ✅ Scrape contacts from Off Market folder
    await page.goto(CONTACTS_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector("tr[data-itemid]", { timeout: 120000 });
    await sleep(1500);

    const leads = await page.evaluate(() => {
      const rows = document.querySelectorAll("tr[data-itemid]");
      const leads = [];

      for (const row of rows) {
        const id = row.getAttribute("data-itemid");
        const nameEl = row.querySelector(".contact-details-link a");
        const fullName = nameEl?.innerText?.trim();
        if (!fullName) continue;

        const phoneDiv = document.querySelector(`div[id='cell-example-${id}-143332']`);
        const phone = phoneDiv?.innerText?.trim() || "";

        const emailEl = document.querySelector(`div[id='cell-example-${id}-143333'] a[href^='mailto:']`);
        const email = emailEl?.getAttribute("href")?.replace("mailto:", "").trim() || "";

        const nameParts = fullName.split(" ");
        leads.push({
          full_name: fullName,
          first_name: nameParts[0] || "",
          last_name: nameParts.slice(1).join(" "),
          phone,
          email,
          contact_id: id
        });
      }

      return leads;
    });

    console.log(`✅ Found ${leads.length} raw leads in "Off Market"`);

    // 📥 Deduplication
    const seen = new Set(), filtered = [], dupes = [];
    for (const lead of leads) {
      const key = `${lead.full_name}|${lead.phone}`;
      if (lead.full_name.toLowerCase() === "possible owner" || !seen.has(key)) {
        seen.add(key);
        filtered.push(lead);
      } else {
        dupes.push(lead);
      }
    }

    const unsentLeads = filtered;

    for (const lead of unsentLeads) {
      const detailPage = await browser.newPage();
      try {
        const detailUrl = `https://www.vulcan7dialer.com/cm/index#contact/${lead.contact_id}`;
        await detailPage.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 120000 });

        await detailPage.waitForFunction(() => {
          const ths = Array.from(document.querySelectorAll("th"));
          return ths.some(th => th.textContent.includes("MLS Number"));
        }, { timeout: 15000 });

        const detailData = await detailPage.evaluate(() => {
          const clean = (t) => (t || "").replace(/\s+/g, " ").trim();

          const getTextAfterTh = (label) => {
            const ths = Array.from(document.querySelectorAll("tr th"));
            for (const th of ths) {
              const thText = clean(th.textContent || "").toLowerCase();
              if (thText.includes(label.toLowerCase().replace(":", ""))) {
                const td = th.nextElementSibling;
                return td ? clean(td.textContent) : "";
              }
            }
            return "";
          };

          const getBedsAndBaths = () => {
            const val = getTextAfterTh("Beds");
            const [bedsRaw, bathsRaw] = val.split("/").map(v => clean(v));
            return {
              beds: bedsRaw || "",
              baths: bathsRaw || ""
            };
          };

          // Address object
          let address = { street: "", city: "", state: "", zip: "" };
          const addrEl = document.querySelector('a[data-type="address"]');
          if (addrEl) {
            try {
              const data = JSON.parse(addrEl.getAttribute("data-value") || "{}");
              address = {
                street: data.address || "",
                city: data.city || "",
                state: data.state || "",
                zip: data.zip || ""
              };
            } catch {}
          }

          // Link grabber
          const links = Array.from(document.querySelectorAll("a[href]")).map(a => a.getAttribute("href"));

          const matchLink = (pattern) => {
            const regex = new RegExp(pattern, "i");
            return links.find(href => regex.test(href)) || "";
          };

          const zillowRelative = links.find(h => h.includes("/zillow/go_to_site")) || "";
          const zillowLink = zillowRelative ? `https://www.vulcan7dialer.com${zillowRelative}` : "";

          const { beds, baths } = getBedsAndBaths();

          return {
            street: address.street,
            city: address.city,
            state: address.state,
            zip: address.zip,
            mls_number: getTextAfterTh("MLS Number"),
            property_type: getTextAfterTh("Property Type"),
            mls_status: getTextAfterTh("MLS Status"),
            status_change_date: getTextAfterTh("Status Change Date"),
            list_price: getTextAfterTh("List Price"),
            beds,
            baths,
            square_footage: getTextAfterTh("Square Footage"),
            days_on_market: getTextAfterTh("Days On Market"),
            listing_agent: getTextAfterTh("Listing Agent"),
            listing_office: getTextAfterTh("Listing Office"),
            zillow_link: zillowLink,
            google_maps_link: matchLink("google\\.(com|ca)/maps|maps\\.google"),
            facebook: matchLink("facebook\\.com"),
            instagram: matchLink("instagram\\.com"),
            linkedin: matchLink("linkedin\\.com"),
            twitter: matchLink("twitter\\.com"),
            tiktok: matchLink("tiktok\\.com"),
            youtube: matchLink("youtube\\.com")
          };
        });

        Object.assign(
          lead,
          {
            street: "", city: "", state: "", zip: "",
            mls_number: "", property_type: "", mls_status: "", status_change_date: "", list_price: "",
            beds: "", baths: "", square_footage: "", days_on_market: "",
            listing_agent: "", listing_office: "",
            zillow_link: "", google_maps_link: "",
            facebook: "", instagram: "", linkedin: "", twitter: "", tiktok: "", youtube: ""
          },
          detailData
        );

      } catch (err) {
        console.error(`⚠️ Detail fetch failed for ${lead.full_name}: ${err.message}`);
        try {
          await detailPage.screenshot({ path: `failure_${lead.contact_id}.png`, fullPage: true });
        } catch {}
      } finally {
        await detailPage.close();
        await sleep(300);
      }
    }

    // 📤 Send to Zapier
    for (const lead of unsentLeads) {
      try {
        await axios.post(WEBHOOK_URL, { timestamp: new Date().toISOString(), lead });
        console.log(`📤 Sent: ${lead.full_name}`);
      } catch (err) {
        console.error(`❌ Failed to send ${lead.full_name}: ${err.message}`);
      }
    }

  } catch (err) {
    console.error("❌ Script Error:", err);
    try { await page.screenshot({ path: "failure.png", fullPage: true }); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();

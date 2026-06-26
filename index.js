import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveVacancy } from './db.js';
import { sendTelegramNotification } from './notifier.js';
import { processStandardSite, processJibeSite, dismissCookieBanner } from './scraper-strategies.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const configPath = path.resolve(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  throw new Error(`CRITICAL: config.json не знайдено: ${configPath}`);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const iconNew = '\u{1F195}';      
const iconCompany = '\u{1F3E2}';  
const iconLocation = '\u{1F4CD}'; 
const iconLink = '\u{1F517}';

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Фільтр локації
function isRelevantLocation(location) {
  if (!location) return false;
  const loc = location.toLowerCase();
  return [
    'poznan', 'poznań',
    'remote', 'zdalnie', 'zdalna',
    'hybrid', 'hybrydowo', 'hybrydowa',
    'any city', 'dowolne miasto', 'multiple locations', 'anywhere'
  ].some(kw => loc.includes(kw));
}

// Фільтр назви посади
function isRelevantJobTitle(title) {
  if (!title) return false;

  const normalizedTitle = title.toLowerCase();

  const allowedKeywords = [
    'l2', 'l3', 'support', 'helpdesk',
    'specialist', 'consultant', 'specjalist', 'specjalista',
    'sysadmin', 'system admin', 'administrator', 'engineer',
    'systemów telekomunikacyjnych', 'zabezpieczenia', 'koordynator',
    'qa', 'tester', 'quality assurance', 'automation', 'application', 'danych',
    'security', 'bezpieczeństw', 'cyber', 'cyberbezpieczeństwa',
    'cyfrowych', 'incident', 'cyfryzacj'
  ];

  const blockedRegexes = [
    'sprzedaż', 'sales', 'electrical', 'inwestycji', 'business', 'trade', 'risk',
    'senior', 'lead', 'principal', 'leader', 'director', 'architect', 'marketing',
    'hr', 'human', 'recepcja', 'biura', 'murex', 'invest', 'affair', 'tax'
  ].map(kw => new RegExp(`\\b${kw}\\b`, 'i'));

  if (blockedRegexes.some(re => re.test(title))) return false;
  if (allowedKeywords.length === 0) return true;
  return allowedKeywords.some(kw => normalizedTitle.includes(kw));
}

// Головна функція
async function runScraper() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled']
  });

  for (const target of config) {
    console.log(`[ІНФО] Аналіз джерела: ${target.companyName}`);

    if (!target.url?.startsWith('http')) {
      console.error(`[ПОМИЛКА] Некоректний URL для ${target.companyName}`);
      continue;
    }

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      extraHTTPHeaders: { 'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7' }
    });
    const page = await context.newPage();

    try {
      // 1. Навігація
      const waitUntil = target.waitUntil
        ?? (target.scrapeMethod === 'jibe' ? 'networkidle' : 'domcontentloaded');
      await page.goto(target.url, { waitUntil, timeout: target.timeout ?? 30000 });

      // 2. Cookie-банер
      await dismissCookieBanner(page, target.selectors?.cookieAccept);

      // 3. Pre-actions (заповнення форм фільтрів, наприклад eRecruiter)
      if (Array.isArray(target.preActions)) {
        for (const action of target.preActions) {
          if (action.type === 'select')
            await page.selectOption(action.selector, { label: action.label }).catch(() => {});
          else if (action.type === 'fill')
            await page.fill(action.selector, action.value).catch(() => {});
          else if (action.type === 'click') {
            await page.click(action.selector, { timeout: 5000 }).catch(() => {});
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          }
        }
      }

      // 4. Збір вакансій
      const rawJobs = target.scrapeMethod === 'jibe'
        ? await processJibeSite(page, target)
        : await processStandardSite(page, target);

      if (rawJobs.length === 0) continue;

      // 5. Нормалізація та фільтрація
      const relevantJobs = rawJobs
        .map(job => ({
          ...job,
          link: job.rawLink ? new URL(job.rawLink, target.url).href : ''
        }))
        .filter(job => {
          if (!job.link) return false;
          const isLocValid   = target.strictLocationFilter === false || isRelevantLocation(job.location);
          const isTitleValid = target.skipTitleFilter === true || isRelevantJobTitle(job.title);
          return isLocValid && isTitleValid;
        });

      // 6. Збереження в Supabase + Telegram
      for (const job of relevantJobs) {
        try {
          const isNew = await saveVacancy({
            company_name:  target.companyName,
            job_title:     job.title,
            job_location:  job.location,
            job_url:       job.link
        });

          if (!isNew) continue;

          console.log(`[НОВА ВАКАНСІЯ] ${job.title} | ${job.location}`);
          const msg = `${iconNew} <b>${job.title}</b>\n` +
            `${iconCompany} ${target.companyName}\n` +
            `${iconLocation} ${job.location}\n` +
            `${iconLink} <a href="${job.link}">Перейти до вакансії</a>`;
          
          await sendTelegramNotification(msg)
          .catch(err => console.error(`[ПОМИЛКА TELEGRAM]: ${err.message}`));

        } catch (err) {
          console.error(`[ПОМИЛКА ЗБЕРЕЖЕННЯ] ${job.link}:`, err.message);
        }
      }

    } catch (error) {
      console.error(`[ПОМИЛКА] ${target.companyName}:`, error.message);
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      await delay(Math.floor(Math.random() * 3000) + 2000);
    }
  }

  await browser.close();
}

runScraper();
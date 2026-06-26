const delay = (ms) => new Promise(r => setTimeout(r, ms));
// Універсальна функція санітизації тексту
const sanitizeText = (text) => {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
};
// Регулярка для виявлення "Available in N locations"
const MULTI_LOCATION_RE = /available in \d+ location/i;
// Селектори, специфічні для Phenom-модалки зі списком локацій (GSK тощо)
const MULTI_LOCATION_BUTTON_SELECTOR = '[data-ph-at-id="job-multi_location"]';
const MULTI_LOCATION_MODAL_SELECTOR = '.phw-modal-sm';
const MULTI_LOCATION_ITEM_SELECTOR = '[role="listitem"]';

export async function dismissCookieBanner(page, customCookieSelector = null) {
  // Масив базових локаторів
  const locators = [
    // Стандартні глобальні ідентифікатори
    '#onetrust-reject-all-handler',
    '#onetrust-accept-btn-handler',
    'button.ph-cookie-btn',
    'button[id*="cookie" i]',
    'a[id*="cookie" i]',
    'button:has-text("Accept All")',
    'button:has-text("Reject All")',
    'button:has-text("Accept Cookies")',
    'button:has-text("Akceptuj")',
    'button:has-text("Zaakceptuj")',
    'button:has-text("Zgadzam się")',
    'button:has-text("Akceptuję wszystkie")'
  ];
  // Кастомний селектор із конфіга
  if (customCookieSelector) {
    locators.unshift(customCookieSelector);
  }
  const combinedLocators = locators.join(', ');
  // М'який клік: якщо банера немає, помилка безшумно поглинається
  await page.locator(combinedLocators).first().click({ timeout: 5000 }).catch(() => {});
  // Невелика пауза, щоб анімація зникнення банера встигла завершитись
  await page.waitForTimeout(1500);
}
// Допоміжна функція: розкрити "Available in N locations" через модалку
async function resolveMultiLocation(page, target, rowIndex) {
  const rowLocator = page.locator(target.selectors.jobRow).nth(rowIndex);
  const btn = rowLocator.locator(MULTI_LOCATION_BUTTON_SELECTOR).first();

  if (await btn.count() === 0) return null;

  try {
    await btn.click({ timeout: 5000 });

    const modal = page.locator(MULTI_LOCATION_MODAL_SELECTOR).first();
    await modal.waitFor({ state: 'visible', timeout: 5000 });

    const items = await modal.locator(MULTI_LOCATION_ITEM_SELECTOR).allInnerTexts();
    const locations = items.map(t => sanitizeText(t)).filter(Boolean);

    // Закриваємо модалку клавішею Escape (стандарт для role="dialog")
    await page.keyboard.press('Escape').catch(() => {});
    await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    await delay(300);

    return locations.length ? locations.join(', ') : null;
  } catch {
    // Якщо щось пішло не так закриваємо модалку, щоб не зламати наступні рядки
    await page.keyboard.press('Escape').catch(() => {});
    await delay(300);
    return null;
  }
}

// Стандартні сайти (Allegro, Workday, Phenom/GSK)
export async function processStandardSite(page, target) {
  const allJobsMap = new Map();
  let pageNum = 1;
  const MAX_PAGES = 10; // Ліміт глибини сканування
  const isPinPagination = target.paginationType === 'pins';

  while (pageNum <= MAX_PAGES) {
    console.log(`[ІНФО] ${target.companyName}: сканування сторінки ${pageNum}...`);

    await page.waitForSelector(target.selectors.jobRow, { timeout: target.selectorTimeout ?? 15000 }).catch(() => {});
    const rowCount = await page.locator(target.selectors.jobRow).count();

    if (rowCount === 0) {
      if (pageNum === 1) console.log(`[ІНФО] Вакансій не знайдено на сайті: ${target.companyName}`);
      break;
    }
  const rawJobs = await page.$$eval(
      target.selectors.jobRow,
      (rows, selectors) => {
        return rows.map(row => {
          const titleEl = row.querySelector(selectors.title);
          const locEl = row.querySelector(selectors.location);
          const linkEl = row.querySelector(selectors.link);
          const multiLocBtn = row.querySelector('[data-ph-at-id="job-multi_location"]');

          let location = '';
          if (locEl) {
            location = locEl.innerText;
          } else if (multiLocBtn) {
            location = multiLocBtn.innerText;
          }
          // Гнучке витягнення URL: якщо контейнер row сам є тегом <a>, беремо його атрибут, в іншому випадку — шукаємо вкладений елемент посилання
          let currentLink = row.tagName.toLowerCase() === 'a'
            ? row.getAttribute('href')
            : (linkEl ? linkEl.getAttribute('href') : '');

          if (!currentLink || currentLink === '#' || currentLink.endsWith('/#')) {
            const offerid = row.getAttribute('offerid') || row.getAttribute('jobofferid');
            currentLink = offerid ? `?offerid=${offerid}` : '';
          }

          return {
            title: titleEl ? titleEl.innerText : '',
            location,
            rawLink: currentLink
          };
        });
      },
      target.selectors
    );
    // Реальні кліки
    for (let i = 0; i < rawJobs.length; i++) {
      if (MULTI_LOCATION_RE.test(rawJobs[i].location)) {
        const resolved = await resolveMultiLocation(page, target, i);
        if (resolved) {
          console.log(`[ІНФО] ${target.companyName}: "${sanitizeText(rawJobs[i].title)}" → ${resolved}`);
          rawJobs[i].location = resolved;
        }
      }
    }
    let newOnPage = 0;
    for (const job of rawJobs) {
      // Санітизація даних після екстракції
      job.title = sanitizeText(job.title);
      job.location = sanitizeText(job.location);

      const uniqueKey = job.rawLink || `${job.title}-${job.location}`;
      if (!allJobsMap.has(uniqueKey)) {
        allJobsMap.set(uniqueKey, job);
        newOnPage++;
      }
    }
    // При відсутности нових унікальних вакансій на новій сторінці перериваємо
    if (newOnPage === 0) {
      break;
    }
    // Якщо досягли ліміту, не намагаємося переходити далі
    if (pageNum >= MAX_PAGES) {
      break;
    }
    // Пагінація
    let clickedNext = false;
    if (isPinPagination && target.selectors.pinButton) {
      // Шукаємо кнопку з точним номером наступної сторінки
      const nextPageIndex = pageNum + 1;
      const nextPin = page.locator(`${target.selectors.pinButton}:text-is("${nextPageIndex}")`).first();
      if (await nextPin.isVisible().catch(() => false)) {
      await nextPin.click({ timeout: 5000 });
      clickedNext = true;
      }
    } else if (target.selectors.nextPage) {
      const nextBtn = page.locator(target.selectors.nextPage).first();
      const isVisible = await nextBtn.isVisible().catch(() => false);
      // Перевірка стану елемента безпосередньо в DOM
      const isDisabled = await nextBtn.evaluate(node => 
        node.hasAttribute('disabled') || 
        node.classList.contains('disabled') || 
        node.getAttribute('aria-disabled') === 'true'
      ).catch(() => false);

      if (isVisible && !isDisabled) {
        await nextBtn.click({ timeout: 5000 });
        clickedNext = true;
      }
    }    
      // Якщо кнопки більше немає, завершуємо збір
     if (!clickedNext) {
      break;
     }
    await delay(2500); // Очікування рендерингу після кліку
    // Очікування завершення фонових запитів, викликаних кліком (з ігноруванням помилки таймауту)
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
     
    pageNum++;
  }

  return Array.from(allJobsMap.values());
}

// Сайти на платформі Jibe
export async function processJibeSite(page, target) {
  const basePath = '/jobs/';
  const isReady = await waitForJibeJobLinks(page, basePath);

  if (!isReady) {
    console.log(`[ІНФО] Вакансій не знайдено на Jibe-сайті: ${target.companyName}`);
    return [];
  }

  console.log(`[ІНФО] Компанія ${target.companyName} (Jibe): збір даних...`);

  const rawJobs = await page.evaluate(() => {
    const seen = new Set();
    const results = [];

    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      const jobsIdx = href.indexOf('/jobs/');

      if (jobsIdx === -1) continue;
      const afterJobs = href.slice(jobsIdx + 6).replace(/^\//, '');
      if (!afterJobs || afterJobs.startsWith('?')) continue;
      if (seen.has(href)) continue;
      seen.add(href);

      const title = a.innerText;
      if (!title || /apply/i.test(title)) continue;

      let location = '';
      let el = a.parentElement;
      for (let i = 0; i < 8 && el; i++) {
        const locEl = el.querySelector('span.label-value.location, .label-value.location');
        if (locEl) {
          location = locEl.innerText;
          break;
        }
        el = el.parentElement;
      }

      results.push({ title, location, rawLink: href });
    }
    return results;
  });

  // Санітизація результатів Jibe
  return rawJobs.map(job => ({
    title: sanitizeText(job.title),
    location: sanitizeText(job.location),
    rawLink: job.rawLink
  }));
}

async function waitForJibeJobLinks(page, basePath, timeout = 35000) {
  try {
    await page.waitForFunction(
      (path) => {
        const links = [...document.querySelectorAll('a[href]')].filter(a => {
          const h = a.getAttribute('href') || '';
          const idx = h.indexOf(path);
          if (idx === -1) return false;

          const after = h.slice(idx + path.length).replace(/^\//, '');
          return after.length > 0 && !after.startsWith('?');
        });
        return links.length > 0;
      },
      basePath,
      { timeout, polling: 500 }
    );
    return true;
  } catch {
    return false;
  }
}
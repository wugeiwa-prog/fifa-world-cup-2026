const FIFA_NEWS_URL = "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/news";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://dngazmrtmtdahbrlazcj.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_-bRXY4XdE8-mbyEHVnxvGw_EfCd8RuY";
const DRY_RUN = process.env.DRY_RUN === "1";
const MAX_ITEMS = Number(process.env.NEWS_MAX_ITEMS || 12);
const WRITE_INITIAL_FALLBACK = process.env.NEWS_WRITE_INITIAL_FALLBACK !== "0";

const USER_AGENT = "wc2026-friends-news-snapshot/1.0 (+https://github.com/)";
const FALLBACK_ITEMS = [
  {
    title: "FIFA World Cup 26 official news",
    url: FIFA_NEWS_URL,
    source: "FIFA",
    publishedAt: "",
    tag: "官方入口",
    summaryZh: "FIFA 官方新闻入口，点击查看最新发布。"
  },
  {
    title: "Scores, fixtures and match centre",
    url: "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/scores-fixtures",
    source: "FIFA",
    publishedAt: "",
    tag: "赛程比分",
    summaryZh: "FIFA 官方赛程、比赛中心和比分入口。"
  },
  {
    title: "Teams | FIFA World Cup 26",
    url: "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/teams",
    source: "FIFA",
    publishedAt: "",
    tag: "球队",
    summaryZh: "48 支参赛队的 FIFA 官方球队页入口。"
  }
];

function absUrl(url) {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  if (url.startsWith("/")) return `https://www.fifa.com${url}`;
  return new URL(url, FIFA_NEWS_URL).toString();
}

function cleanText(text) {
  return String(text || "")
    .replace(/\\u002F/g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003C/g, "<")
    .replace(/\\u003E/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.url || item.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchHtml() {
  const res = await fetch(FIFA_NEWS_URL, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.8,zh-CN;q=0.6"
    }
  });
  if (!res.ok) throw new Error(`FIFA news HTTP ${res.status}`);
  return res.text();
}

function fromJsonLd(html) {
  const items = [];
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(html))) {
    try {
      const data = JSON.parse(cleanText(match[1]));
      const nodes = Array.isArray(data) ? data : [data];
      nodes.forEach((node) => {
        const list = node?.itemListElement || node?.mainEntity?.itemListElement || [];
        (Array.isArray(list) ? list : []).forEach((entry) => {
          const obj = entry?.item || entry;
          const title = cleanText(obj?.headline || obj?.name);
          const url = absUrl(obj?.url);
          if (title && url && url.includes("fifa.com")) {
            items.push({ title, url, source: "FIFA", publishedAt: obj.datePublished || obj.dateModified || "", tag: "官方动态" });
          }
        });
        const title = cleanText(node?.headline || node?.name);
        const url = absUrl(node?.url || node?.mainEntityOfPage);
        if (title && url && url.includes("fifa.com")) {
          items.push({ title, url, source: "FIFA", publishedAt: node.datePublished || node.dateModified || "", tag: "官方动态" });
        }
      });
    } catch {}
  }
  return items;
}

function fromNextData(html) {
  const items = [];
  const text = html.replace(/\\\//g, "/");
  const urlRe = /"url"\s*:\s*"([^"]*\/en\/tournaments\/mens\/worldcup\/canadamexicousa2026\/(?:articles|news)\/[^"]+)"/g;
  let match;
  while ((match = urlRe.exec(text))) {
    const start = Math.max(0, match.index - 2200);
    const end = Math.min(text.length, match.index + 1200);
    const chunk = text.slice(start, end);
    const titleMatch =
      chunk.match(/"title"\s*:\s*"([^"]{12,180})"/) ||
      chunk.match(/"headline"\s*:\s*"([^"]{12,180})"/) ||
      chunk.match(/"name"\s*:\s*"([^"]{12,180})"/);
    const dateMatch = chunk.match(/"publishedAt"\s*:\s*"([^"]+)"/) || chunk.match(/"datePublished"\s*:\s*"([^"]+)"/);
    const title = cleanText(titleMatch?.[1]);
    const url = absUrl(match[1]);
    if (title && url && !title.includes("FIFA World Cup 26™")) {
      items.push({ title, url, source: "FIFA", publishedAt: dateMatch?.[1] || "", tag: "官方动态" });
    }
  }
  return items;
}

function fromAnchors(html) {
  const items = [];
  const anchorRe = /<a\b[^>]*href=["']([^"']*\/en\/tournaments\/mens\/worldcup\/canadamexicousa2026\/(?:articles|news)\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html))) {
    const title = cleanText(match[2]);
    const url = absUrl(match[1]);
    if (title.length >= 12 && title.length <= 180 && url.includes("fifa.com")) {
      items.push({ title, url, source: "FIFA", publishedAt: "", tag: "官方动态" });
    }
  }
  return items;
}

function summarize(title) {
  const t = cleanText(title);
  if (/schedule|fixture|match/i.test(t)) return "FIFA 官方赛程相关动态，点击查看原文。";
  if (/team|squad|player|coach/i.test(t)) return "FIFA 官方球队或球员相关动态，点击查看原文。";
  if (/ticket|fan|venue|stadium/i.test(t)) return "FIFA 官方球迷、球场或观赛相关动态，点击查看原文。";
  return "FIFA 官方动态标题快照，点击查看原文。";
}

function extractItems(html) {
  return dedupe([...fromJsonLd(html), ...fromNextData(html), ...fromAnchors(html)])
    .filter((item) => item.title && item.url && item.url.includes("fifa.com"))
    .slice(0, MAX_ITEMS)
    .map((item) => ({ ...item, title: item.title.slice(0, 160), summaryZh: summarize(item.title) }));
}

async function upsertNews(items) {
  const now = new Date().toISOString();
  const payload = {
    key: "news",
    data: {
      items,
      source: "FIFA",
      sourceUrl: FIFA_NEWS_URL,
      fetchedAt: now
    },
    updated_at: now
  };
  if (DRY_RUN) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/wc2026_sync_meta`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Supabase news upsert HTTP ${res.status}: ${await res.text()}`);
}

async function hasExistingSnapshot() {
  if (DRY_RUN) return false;
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/wc2026_sync_meta?key=eq.news&select=data`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`
    }
  });
  if (!res.ok) return false;
  const row = (await res.json())[0];
  return Array.isArray(row?.data?.items) && row.data.items.length > 0;
}

async function main() {
  const html = await fetchHtml();
  const items = extractItems(html);
  if (!items.length) {
    if (await hasExistingSnapshot()) {
      console.log("No FIFA news items extracted; keeping previous Supabase snapshot unchanged.");
      return;
    }
    if (WRITE_INITIAL_FALLBACK) {
      await upsertNews(FALLBACK_ITEMS);
      console.log("No FIFA news items extracted; saved official fallback links as initial snapshot.");
      return;
    }
    console.log("No FIFA news items extracted; keeping previous Supabase snapshot unchanged.");
    return;
  }
  await upsertNews(items);
  console.log(`Saved ${items.length} FIFA news title snapshots.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

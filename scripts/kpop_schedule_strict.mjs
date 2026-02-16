#!/usr/bin/env node
import { DateTime } from "luxon";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import minimist from "minimist";

const INDEX_URL = "https://kpopofficial.com/kpop-comebacks/";
const TZ = "Asia/Seoul";

function home(){ return process.env.HOME || process.env.USERPROFILE || "."; }
function outDir(){ return process.env.KPOP_SCHEDULE_DIR || path.join(home(), ".openclaw", "kpop_schedule_strict"); }
async function ensureDir(p){ await fs.mkdir(p, {recursive:true}); }

const sha1 = (s)=>crypto.createHash("sha1").update(s).digest("hex");
const sha256 = (s)=>crypto.createHash("sha256").update(s).digest("hex");

function randInt(min, max){
  return Math.floor(min + Math.random() * (max - min + 1));
}
async function sleep(ms){ await new Promise(r=>setTimeout(r, ms)); }

function looksLikeChallenge(html){
  const t=(html||"").toLowerCase();
  return t.includes("cloudflare") || t.includes("checking your browser")
      || t.includes("attention required") || t.includes("enable javascript")
      || t.includes("ddos protection");
}

function cleanUrl(u){
  try{
    const x=new URL(u);
    x.hash=""; x.search="";
    return x.toString();
  }catch{ return u; }
}

async function fetchHtml(url, {timeoutMs=25000, retries=2, backoffBaseMs=800} = {}){
  const headers = {
    "user-agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "accept":"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language":"en-US,en;q=0.9,ko;q=0.7,zh-CN;q=0.6,zh;q=0.5",
    "cache-control":"no-cache",
    "pragma":"no-cache",
    "referer":"https://kpopofficial.com/"
  };

  let last=null;
  for(let i=0;i<=retries;i++){
    try{
      const ctrl = new AbortController();
      const t = setTimeout(()=>ctrl.abort(), timeoutMs);
      const res = await fetch(url, {headers, signal: ctrl.signal, redirect:"follow"});
      clearTimeout(t);

      // Retry on typical throttle codes
      if([429, 500, 502, 503, 504].includes(res.status)){
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      if(!res.ok){
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      return await res.text();
    }catch(e){
      last=e;
      const wait = backoffBaseMs * Math.pow(2, i) + randInt(0, 400);
      await sleep(wait);
    }
  }
  throw last;
}

function parseDateDisplay(dateText){
  // Strict: only consider "dated" if we can parse a day.
  const m = (dateText||"").match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s*(\d{4}))?/i);
  if(!m){
    return { display:"待定（未公布具体日期）", iso_day:null, precision:"tbd", raw: dateText||"" };
  }
  const monthMap = {january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
  const month = monthMap[m[1].toLowerCase()];
  const day = Number(m[2]);
  const year = m[3] ? Number(m[3]) : DateTime.now().setZone(TZ).year;
  const dt = DateTime.fromObject({year,month,day},{zone:TZ});
  return { display: dt.toISODate(), iso_day: dt.toISODate(), precision:"day", raw: dateText||"" };
}

function classifyMeta(meta){
  const monthWords = /(January|February|March|April|May|June|July|August|September|October|November|December)/i;
  const dateText = meta.find(t=>monthWords.test(t) || /Coming Soon/i.test(t)) || "";
  const title = meta.find(t=>/(EP|Album|Single|OST|Repackage)/i.test(t))
             || meta.find(t=>/ – /i.test(t) && !/Coming Soon/i.test(t))
             || "";
  const monthAbbrev = /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)$/i;
  const artist = meta.find(t=>t && t!==dateText && t!==title && !monthWords.test(t) && !/Coming Soon/i.test(t)
                    && !monthAbbrev.test(t) && !/(EP|Album|Single|OST|Repackage)/i.test(t)) || "";
  return {dateText, artist, title};
}

function slugFromUrl(u){
  try{
    const url=new URL(u);
    const parts=url.pathname.split("/").filter(Boolean);
    return parts[parts.length-1] || sha1(u).slice(0,10);
  }catch{ return sha1(u).slice(0,10); }
}

function pickSection($, headingText){
  const header = $("h2, h3").filter((_,el)=>$(el).text().trim().toLowerCase()===headingText.toLowerCase()).first();
  if(!header || !header.length) return {text:"", links:[], images:[]};
  const section = header.nextUntil("h2, h3");
  const text = section.text().replace(/\s+/g," ").trim();
  const links=[];
  section.find("a[href]").each((_,a)=>{
    const href=$(a).attr("href"); if(!href) return;
    links.push({text: $(a).text().replace(/\s+/g," ").trim(), href: cleanUrl(href)});
  });
  const images=[];
  section.find("img").each((_,img)=>{
    const src=$(img).attr("src")||$(img).attr("data-src")||$(img).attr("data-lazy-src")||"";
    if(src) images.push(cleanUrl(src));
  });
  return {text, links, images};
}

function escapeRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }
function extractField(sectionText,label,nextLabels){
  if(!sectionText) return null;
  const t=sectionText.replace(/\s+/g," ").trim();
  const re=new RegExp(`${escapeRe(label)}\\s*(.*?)\\s*(?=\\b(${nextLabels.map(escapeRe).join("|")})\\b)`, "i");
  const m=t.match(re);
  return m?m[1].trim():null;
}

function computeAlbumHash(a){
  const stable={
    url:a.url, title:a.title, artist:a.artist, album:a.album, title_track:a.title_track,
    release:a.release, tracklist:a.tracklist||[],
    links:a.links_album_details||[],
    teaser:(a.teaser_poster_images||[]).slice(0,3),
    comeback:(a.comeback_teaser_images||[]).slice(0,3)
  };
  return sha256(JSON.stringify(stable));
}

async function fetchAlbumDetail(url, mode){
  const html = await fetchHtml(url, {retries: mode==="human" ? 2 : 3, backoffBaseMs: mode==="human" ? 1200 : 600});
  if(looksLikeChallenge(html)){
    const err = new Error("challenge-like HTML");
    err.code = "CHALLENGE";
    throw err;
  }
  const $ = cheerio.load(html);
  const title = $("h1").first().text().replace(/\s+/g," ").trim() || "";

  const details = pickSection($,"Album Details");
  const artist = extractField(details.text,"Artist",["Release Date","Album","Title Track","Tracklist","Pre-save","Buy Album","Official Source","Total Views"]) || "";
  const releaseRaw = extractField(details.text,"Release Date",["Album","Title Track","Tracklist","Pre-save","Buy Album","Official Source","Total Views"]) || "";
  const album = extractField(details.text,"Album",["Title Track","Tracklist","Pre-save","Buy Album","Official Source","Total Views"]) || "";
  const titleTrack = extractField(details.text,"Title Track",["Tracklist","Pre-save","Buy Album","Official Source","Total Views"]) || "";
  const tracklistRaw = extractField(details.text,"Tracklist",["Pre-save","Buy Album","Official Source","Total Views"]) || "";

  let tracklist=[];
  if(tracklistRaw){
    const parts = tracklistRaw.split(/\s*\d+\.\s*/).map(x=>x.trim()).filter(Boolean);
    tracklist = parts.length ? parts : tracklistRaw.split(/\s*[|/]\s*|,\s*/).map(x=>x.trim()).filter(Boolean);
    tracklist = Array.from(new Set(tracklist)).slice(0,60);
  }

  const teaser = pickSection($,"Teaser Poster");
  const comeback = pickSection($,"Comeback Teaser");
  const version = pickSection($,"Album Version");

  const parsed = parseDateDisplay(releaseRaw);
  const release = { raw: releaseRaw, display: parsed.display, iso_day: parsed.iso_day, precision: parsed.precision };

  const obj = {
    url,
    fetched_at: DateTime.now().setZone(TZ).toISO(),
    title,
    artist,
    album,
    title_track: titleTrack,
    release,
    tracklist,
    links_album_details: details.links||[],
    teaser_poster_images: teaser.images||[],
    comeback_teaser_images: comeback.images||[],
    album_version_images: version.images||[],
  };
  obj.hash = computeAlbumHash(obj);
  return obj;
}

async function loadState(statePath){
  try{ return JSON.parse(await fs.readFile(statePath, "utf8")); }
  catch{ return {saved_at:null, albums:{}}; }
}

async function saveState(statePath, state){
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

function shouldRefreshAlbum(state, url, refreshDays, force){
  if(force) return true;
  const rec = state.albums?.[url];
  if(!rec?.fetched_at) return true;
  const last = DateTime.fromISO(rec.fetched_at, {zone:TZ});
  if(!last.isValid) return true;
  const ageDays = DateTime.now().setZone(TZ).diff(last, "days").days;
  return ageDays >= refreshDays;
}

async function run(){
  const argv = minimist(process.argv.slice(2), {
    string:["mode"],
    default:{
      mode:"human",
      limit:80,
      concurrency:1,
      "refresh-days":7,
      "min-delay-ms":900,
      "max-delay-ms":2200,
      "break-every":12,
      "break-min-ms":8000,
      "break-max-ms":25000,
      force:false
    }
  });

  const mode = (argv.mode || "human").toLowerCase();
  const limit = Math.max(1, Number(argv.limit)||80);
  let concurrency = Math.max(1, Math.min(12, Number(argv.concurrency)||1));
  const refreshDays = Math.max(0, Number(argv["refresh-days"]||7));
  const minDelay = Math.max(0, Number(argv["min-delay-ms"]||900));
  const maxDelay = Math.max(minDelay, Number(argv["max-delay-ms"]||2200));
  const breakEvery = Math.max(3, Number(argv["break-every"]||12));
  const breakMin = Math.max(0, Number(argv["break-min-ms"]||8000));
  const breakMax = Math.max(breakMin, Number(argv["break-max-ms"]||25000));
  const force = !!argv.force;

  // human mode guardrails
  if(mode === "human"){
    concurrency = Math.min(concurrency, 2);
  }

  const out = outDir();
  await ensureDir(out);
  await ensureDir(path.join(out, "albums"));
  await ensureDir(path.join(out, "raw"));
  const statePath = path.join(out, "state.json");
  const summaryPath = path.join(out, "summary.json");

  const warnings = [];
  const today = DateTime.now().setZone(TZ).toISODate();

  // Fetch index
  const indexHtml = await fetchHtml(INDEX_URL, {retries: 3, backoffBaseMs: mode==="human" ? 1200 : 600});
  await fs.writeFile(path.join(out, "raw", "index.html"), indexHtml, "utf8");
  if(looksLikeChallenge(indexHtml)){
    warnings.push("index page looks like challenge HTML; data may be empty");
  }

  const $ = cheerio.load(indexHtml);
  const items = [];
  const urls = [];

  $("li.gspbgrid_item").each((_,li)=>{
    const card = $(li);
    const link = card.find("a.gspbgrid_item_link[href]").attr("href")
      || card.find("a.gspb-containerlink[href]").attr("href")
      || card.find("a[href*='/album/']").first().attr("href");
    if(!link) return;

    const detail = cleanUrl(link);

    const meta=[];
    card.find(".gspb_meta_value").each((_,el)=>{ meta.push($(el).text().replace(/\s+/g," ").trim()); });
    const uniq=[];
    for(const m of meta){ if(m && !uniq.includes(m)) uniq.push(m); }

    const {dateText, artist, title} = classifyMeta(uniq);
    const parsed = parseDateDisplay(dateText);

    // Only drop when explicit day is in the past
    if(parsed.iso_day && parsed.iso_day < today) return;

    const display_date = parsed.iso_day ? parsed.display : "待定（未公布具体日期）";

    items.push({
      sort_key: parsed.iso_day ? parsed.iso_day : "9999-12-31",
      回归日期: display_date,
      艺人: artist || "待定（未公布具体信息）",
      专辑名: title || "待定（未公布具体信息）",
      详情链接: detail,
      date_text_raw: dateText || ""
    });
    urls.push(detail);
  });

  // Sort schedule
  items.sort((a,b)=>{
    if(a.sort_key !== b.sort_key) return a.sort_key.localeCompare(b.sort_key);
    const aa=(a.艺人||"").toLowerCase(), bb=(b.艺人||"").toLowerCase();
    if(aa!==bb) return aa.localeCompare(bb);
    return (a.专辑名||"").toLowerCase().localeCompare((b.专辑名||"").toLowerCase());
  });

  const schedule = items.map(({sort_key, ...rest})=>rest);
  await fs.writeFile(path.join(out, "schedule.json"), JSON.stringify(schedule, null, 2), "utf8");

  const uniqueUrls = Array.from(new Set(urls)).slice(0, limit);
  const state = await loadState(statePath);

  // Decide fetch list (incremental)
  const toFetch = [];
  for(const u of uniqueUrls){
    if(shouldRefreshAlbum(state, u, refreshDays, force)){
      toFetch.push(u);
    }
  }

  let blocked = false;
  let fetchedOk = 0;
  let fetchedFail = 0;
  let skipped = uniqueUrls.length - toFetch.length;

  // Worker pool with human-like pacing
  let idx=0;
  let requestCount=0;

  async function humanPause(){
    // short pause between requests
    await sleep(randInt(minDelay, maxDelay));
    requestCount++;
    if(requestCount % breakEvery === 0){
      await sleep(randInt(breakMin, breakMax));
    }
  }

  const workers = Array.from({length: concurrency}, async ()=>{
    while(idx < toFetch.length && !blocked){
      const i = idx++;
      const u = toFetch[i];
      const slug = slugFromUrl(u);
      try{
        // pace before request in human mode
        if(mode === "human") await humanPause();

        const album = await fetchAlbumDetail(u, mode);
        await fs.writeFile(path.join(out, "albums", slug + ".json"), JSON.stringify(album, null, 2), "utf8");
        state.albums = state.albums || {};
        state.albums[u] = {slug, hash: album.hash, fetched_at: album.fetched_at};
        fetchedOk++;
      }catch(e){
        fetchedFail++;
        const msg = String(e?.message || e);
        if(e?.code === "CHALLENGE" || msg.toLowerCase().includes("challenge")){
          blocked = true;
          warnings.push(`详情页疑似挑战/拦截，已停止继续抓取：${u}`);
        }else{
          warnings.push(`详情页抓取失败：${u} :: ${msg}`);
        }
        // In human mode, add a longer cool-down on failures
        if(mode === "human") await sleep(randInt(3000, 9000));
      }
    }
  });

  await Promise.all(workers);

  state.saved_at = DateTime.now().setZone(TZ).toISO();
  await saveState(statePath, state);

  const summary = {
    ok: true,
    mode,
    today,
    count_schedule: schedule.length,
    urls_total: uniqueUrls.length,
    details_to_fetch: toFetch.length,
    details_skipped_cached: skipped,
    details_fetched_ok: fetchedOk,
    details_fetched_failed: fetchedFail,
    blocked,
    refresh_days: refreshDays,
    output_dir: out,
    outputs: {
      schedule: path.join(out, "schedule.json"),
      albums_dir: path.join(out, "albums"),
      state: statePath,
      summary: summaryPath
    },
    warnings
  };

  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

run().catch(e=>{ console.error(e); process.exit(1); });

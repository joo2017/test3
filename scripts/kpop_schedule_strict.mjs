#!/usr/bin/env node
import { DateTime } from "luxon";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import minimist from "minimist";

const INDEX_URL = "https://kpopofficial.com/kpop-comebacks/";
const CATEGORY_URL = "https://kpopofficial.com/category/kpop-comeback-schedule/";
const SITE = "https://kpopofficial.com";
const TZ = "Asia/Seoul";

function home(){ return process.env.HOME || process.env.USERPROFILE || "."; }
function outDir(){ return process.env.KPOP_SCHEDULE_DIR || path.join(home(), ".openclaw", "kpop_schedule_strict"); }
async function ensureDir(p){ await fs.mkdir(p, {recursive:true}); }

const sha1 = (s)=>crypto.createHash("sha1").update(s).digest("hex");

function randInt(min, max){ return Math.floor(min + Math.random() * (max - min + 1)); }
async function sleep(ms){ await new Promise(r=>setTimeout(r, ms)); }

function looksLikeChallenge(html){
  const t=(html||"").toLowerCase();
  return t.includes("cloudflare") || t.includes("checking your browser")
      || t.includes("attention required") || t.includes("enable javascript")
      || t.includes("ddos protection");
}

function cleanUrl(u){
  try{ const x=new URL(u); x.hash=""; x.search=""; return x.toString(); }
  catch{ return u; }
}

async function fetchHtml(url, {timeoutMs=25000, retries=2, backoffBaseMs=800} = {}){
  const headers = {
    "user-agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "accept":"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language":"en-US,en;q=0.9,ko;q=0.7,zh-CN;q=0.6,zh;q=0.5",
    "cache-control":"no-cache",
    "pragma":"no-cache",
    "referer": SITE + "/"
  };
  let last=null;
  for(let i=0;i<=retries;i++){
    try{
      const ctrl=new AbortController();
      const t=setTimeout(()=>ctrl.abort(), timeoutMs);
      const res=await fetch(url, {headers, signal: ctrl.signal, redirect:"follow"});
      clearTimeout(t);
      if([429,500,502,503,504].includes(res.status)) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    }catch(e){
      last=e;
      const wait = backoffBaseMs * Math.pow(2, i) + randInt(0, 400);
      await sleep(wait);
    }
  }
  throw last;
}

// Discover monthly pages (paginate category) + fallback index
function extractMonthlyLinks(html, baseUrl){
  const $=cheerio.load(html);
  const out=new Set();
  $("a[href]").each((_,a)=>{
    const href=$(a).attr("href"); if(!href) return;
    const abs=cleanUrl(new URL(href, baseUrl).toString());
    if(abs.startsWith(SITE) && /kpop-comeback-schedule/i.test(abs)) out.add(abs);
  });
  return Array.from(out);
}
function nextPageUrl(html, currentUrl){
  const $=cheerio.load(html);
  const next = $('link[rel="next"]').attr("href") || $('a[rel="next"]').attr("href");
  if(next) return cleanUrl(new URL(next, currentUrl).toString());
  if(!/\/page\/\d+\//.test(currentUrl)) return currentUrl.replace(/\/$/, "") + "/page/2/";
  const m=currentUrl.match(/\/page\/(\d+)\//);
  if(m) return currentUrl.replace(/\/page\/\d+\//, `/page/${Number(m[1])+1}/`);
  return null;
}
async function discoverMonthlyPages(maxPages, out, warnings){
  await ensureDir(path.join(out,"raw","monthly_index"));
  const pages=[]; const monthPages=new Set();
  let url=CATEGORY_URL;
  for(let i=0;i<maxPages;i++){
    const html=await fetchHtml(url);
    pages.push(url);
    await fs.writeFile(path.join(out,"raw","monthly_index",`cat-${i+1}.html`), html, "utf8");
    if(looksLikeChallenge(html)) warnings.push(`challenge-like category page: ${url}`);
    extractMonthlyLinks(html, url).forEach(u=>monthPages.add(u));
    const nxt=nextPageUrl(html, url);
    if(!nxt || nxt===url) break;
    url=nxt;
    await sleep(250);
  }
  try{
    const idxHtml=await fetchHtml(INDEX_URL);
    await fs.writeFile(path.join(out,"raw","monthly_index","index.html"), idxHtml, "utf8");
    extractMonthlyLinks(idxHtml, INDEX_URL).forEach(u=>monthPages.add(u));
  }catch(e){
    warnings.push(`index discovery failed: ${String(e)}`);
  }
  const month_pages=Array.from(monthPages); month_pages.sort();
  await fs.writeFile(path.join(out,"month_pages.json"), JSON.stringify({discovered_at: DateTime.now().setZone(TZ).toISO(), pages_scanned: pages, month_pages}, null, 2), "utf8");
  return month_pages;
}

// Year inference from monthly page title/h1
const MONTH_NAMES = /(January|February|March|April|May|June|July|August|September|October|November|December)/i;
function inferYear(html){
  const $=cheerio.load(html);
  const title=(($("h1").first().text()||$("title").text()||"").replace(/\s+/g," ").trim());
  const m=title.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b\s+(\d{4})/i);
  if(m) return {year:Number(m[2]), title};
  const y=title.match(/\b(20\d{2})\b/);
  return {year:y?Number(y[1]):null, title};
}

function parseDateDisplay(dateText, yearHint){
  const m=(dateText||"").match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s*(\d{4}))?/i);
  if(!m) return {display:"待定（未公布具体日期）", iso_day:null, raw: dateText||""};
  const monthMap={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
  const month=monthMap[m[1].toLowerCase()];
  const day=Number(m[2]);
  const year=m[3]?Number(m[3]):(yearHint || DateTime.now().setZone(TZ).year);
  const dt=DateTime.fromObject({year,month,day},{zone:TZ});
  return {display: dt.toISODate(), iso_day: dt.toISODate(), raw: dateText||""};
}

function classifyMeta(meta){
  const dateText = meta.find(t=>MONTH_NAMES.test(t) || /Coming Soon/i.test(t)) || "";
  const title = meta.find(t=>/(EP|Album|Single|OST|Repackage)/i.test(t))
             || meta.find(t=>/ – /i.test(t) && !/Coming Soon/i.test(t))
             || "";
  const monthAbbrev=/^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)$/i;
  const artist = meta.find(t=>t && t!==dateText && t!==title && !MONTH_NAMES.test(t) && !/Coming Soon/i.test(t)
                    && !monthAbbrev.test(t) && !/(EP|Album|Single|OST|Repackage)/i.test(t)) || "";
  return {dateText, artist, title};
}

function extractCardsFromDoc($){
  const cards=[];
  $("li.gspbgrid_item").each((_,li)=>{
    const card=$(li);
    const link = card.find("a.gspbgrid_item_link[href]").attr("href")
      || card.find("a.gspb-containerlink[href]").attr("href")
      || card.find("a[href*='/album/']").first().attr("href");
    if(!link) return;
    const detail=cleanUrl(link);
    const meta=[];
    card.find(".gspb_meta_value").each((_,el)=>meta.push($(el).text().replace(/\s+/g," ").trim()));
    const uniq=[]; for(const m of meta){ if(m && !uniq.includes(m)) uniq.push(m); }
    cards.push({detail_url: detail, meta: uniq});
  });
  return cards;
}

// Album detail fetch (optional)
function slugFromUrl(u){
  try{ const url=new URL(u); const parts=url.pathname.split("/").filter(Boolean); return parts.at(-1)||sha1(u).slice(0,10); }
  catch{ return sha1(u).slice(0,10); }
}
function pickSection($, headingText){
  const header=$("h2, h3").filter((_,el)=>$(el).text().trim().toLowerCase()===headingText.toLowerCase()).first();
  if(!header||!header.length) return {text:"", links:[], images:[]};
  const section=header.nextUntil("h2, h3");
  const text=section.text().replace(/\s+/g," ").trim();
  const links=[];
  section.find("a[href]").each((_,a)=>{ const href=$(a).attr("href"); if(!href) return; links.push({text: $(a).text().replace(/\s+/g," ").trim(), href: cleanUrl(href)}); });
  const images=[];
  section.find("img").each((_,img)=>{ const src=$(img).attr("src")||$(img).attr("data-src")||$(img).attr("data-lazy-src")||""; if(src) images.push(cleanUrl(src)); });
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
async function fetchAlbumDetail(url, mode){
  const html=await fetchHtml(url, {retries: mode==="human"?2:3, backoffBaseMs: mode==="human"?1200:700});
  if(looksLikeChallenge(html)){ const err=new Error("challenge-like HTML"); err.code="CHALLENGE"; throw err; }
  const $=cheerio.load(html);
  const title=$("h1").first().text().replace(/\s+/g," ").trim()||"";
  const details=pickSection($,"Album Details");
  const artist=extractField(details.text,"Artist",["Release Date","Album","Title Track","Tracklist","Pre-save","Buy Album","Official Source","Total Views"])||"";
  const releaseRaw=extractField(details.text,"Release Date",["Album","Title Track","Tracklist","Pre-save","Buy Album","Official Source","Total Views"])||"";
  const album=extractField(details.text,"Album",["Title Track","Tracklist","Pre-save","Buy Album","Official Source","Total Views"])||"";
  const titleTrack=extractField(details.text,"Title Track",["Tracklist","Pre-save","Buy Album","Official Source","Total Views"])||"";
  const tracklistRaw=extractField(details.text,"Tracklist",["Pre-save","Buy Album","Official Source","Total Views"])||"";
  let tracklist=[];
  if(tracklistRaw){
    const parts=tracklistRaw.split(/\s*\d+\.\s*/).map(x=>x.trim()).filter(Boolean);
    tracklist = parts.length ? parts : tracklistRaw.split(/\s*[|/]\s*|,\s*/).map(x=>x.trim()).filter(Boolean);
    tracklist = Array.from(new Set(tracklist)).slice(0,60);
  }
  return {url, fetched_at: DateTime.now().setZone(TZ).toISO(), title, artist, album, title_track: titleTrack, release_raw: releaseRaw, tracklist, links_album_details: details.links||[]};
}
async function loadState(statePath){ try{ return JSON.parse(await fs.readFile(statePath,"utf8")); }catch{ return {saved_at:null, albums:{}}; } }
async function saveState(statePath, state){ await fs.writeFile(statePath, JSON.stringify(state,null,2), "utf8"); }
function shouldRefreshAlbum(state, url, refreshDays, force){
  if(force) return true;
  const rec=state.albums?.[url];
  if(!rec?.fetched_at) return true;
  const last=DateTime.fromISO(rec.fetched_at,{zone:TZ});
  const age=DateTime.now().setZone(TZ).diff(last,"days").days;
  return age >= refreshDays;
}

async function run(){
  const argv=minimist(process.argv.slice(2), {default:{
    source:"monthly","max-pages":12,months:12,mode:"human",limit:120,concurrency:1,"refresh-days":14,
    "min-delay-ms":900,"max-delay-ms":2200,"break-every":12,"break-min-ms":8000,"break-max-ms":25000,"no-albums":false,force:false
  }});
  const source=(argv.source||"monthly").toLowerCase();
  const maxPages=Math.max(1, Number(argv["max-pages"]||12));
  const monthsLimit=Math.max(1, Number(argv.months||12));
  const mode=(argv.mode||"human").toLowerCase();
  const limit=Math.max(1, Number(argv.limit||120));
  let concurrency=Math.max(1, Math.min(12, Number(argv.concurrency||1)));
  const refreshDays=Math.max(0, Number(argv["refresh-days"]||14));
  const minDelay=Math.max(0, Number(argv["min-delay-ms"]||900));
  const maxDelay=Math.max(minDelay, Number(argv["max-delay-ms"]||2200));
  const breakEvery=Math.max(3, Number(argv["break-every"]||12));
  const breakMin=Math.max(0, Number(argv["break-min-ms"]||8000));
  const breakMax=Math.max(breakMin, Number(argv["break-max-ms"]||25000));
  const noAlbums=!!argv["no-albums"];
  const force=!!argv.force;
  if(mode==="human") concurrency=Math.min(concurrency,2);

  const out=outDir();
  await ensureDir(out);
  await ensureDir(path.join(out,"albums"));
  await ensureDir(path.join(out,"raw","monthly"));
  const warnings=[];
  const today=DateTime.now().setZone(TZ).toISODate();
  const nowY=DateTime.now().setZone(TZ).year;

  let monthPages=[];
  if(source==="monthly") monthPages = await discoverMonthlyPages(maxPages, out, warnings);
  else monthPages = [INDEX_URL];

  // Fetch all month pages (up to monthsLimit) with year context; keep only year>=current
  const pageInfos=[];
  for(const p of monthPages){
    try{
      const html=await fetchHtml(p);
      await fs.writeFile(path.join(out,"raw","monthly",`${sha1(p).slice(0,10)}.html`), html, "utf8");
      if(looksLikeChallenge(html)){ warnings.push(`challenge-like monthly HTML: ${p}`); continue; }
      const info=inferYear(html);
      if(info.year && info.year < nowY) continue; // drop old years
      pageInfos.push({url:p, html, year: info.year});
    }catch(e){
      warnings.push(`fetch monthly failed: ${p} :: ${String(e)}`);
    }
    await sleep(200);
  }
  // Sort by year asc then keep first monthsLimit (rough)
  pageInfos.sort((a,b)=>(a.year||9999)-(b.year||9999));
  const used = pageInfos.slice(0, monthsLimit);

  const items=[]; const urls=[];
  for(const pi of used){
    const $=cheerio.load(pi.html);
    const cards=extractCardsFromDoc($);
    for(const c of cards){
      const {dateText, artist, title} = classifyMeta(c.meta);
      const parsed = parseDateDisplay(dateText, pi.year);
      if(parsed.iso_day && parsed.iso_day < today) continue;
      items.push({
        sort_key: parsed.iso_day ? parsed.iso_day : "9999-12-31",
        回归日期: parsed.iso_day ? parsed.display : "待定（未公布具体日期）",
        艺人: artist || "待定（未公布具体信息）",
        专辑名: title || "待定（未公布具体信息）",
        详情链接: c.detail_url,
        date_text_raw: dateText || "",
        source_page: pi.url
      });
      urls.push(c.detail_url);
    }
  }

  // Dedup
  const seen=new Set(); const dedup=[];
  for(const it of items){
    const key=`${it.详情链接}|${it.date_text_raw}|${it.专辑名}|${it.艺人}`;
    if(seen.has(key)) continue;
    seen.add(key); dedup.push(it);
  }

  dedup.sort((a,b)=>{
    if(a.sort_key!==b.sort_key) return a.sort_key.localeCompare(b.sort_key);
    const aa=(a.艺人||"").toLowerCase(), bb=(b.艺人||"").toLowerCase();
    if(aa!==bb) return aa.localeCompare(bb);
    return (a.专辑名||"").toLowerCase().localeCompare((b.专辑名||"").toLowerCase());
  });

  const schedule=dedup.map(({sort_key, ...rest})=>rest);
  await fs.writeFile(path.join(out,"schedule.json"), JSON.stringify(schedule,null,2), "utf8");

  const uniqueUrls=Array.from(new Set(urls)).slice(0, limit);
  let blocked=false, fetchedOk=0, fetchedFail=0, skipped=0;

  if(!noAlbums){
    const statePath=path.join(out,"state.json");
    const state=await loadState(statePath);
    const toFetch=[];
    for(const u of uniqueUrls){
      if(shouldRefreshAlbum(state, u, refreshDays, force)) toFetch.push(u);
      else skipped++;
    }

    let idx=0; let reqCount=0;
    async function humanPause(){
      await sleep(randInt(minDelay, maxDelay));
      reqCount++;
      if(reqCount % breakEvery === 0) await sleep(randInt(breakMin, breakMax));
    }

    const workers=Array.from({length: concurrency}, async ()=>{
      while(idx<toFetch.length && !blocked){
        const i=idx++; const u=toFetch[i];
        const slug=slugFromUrl(u);
        try{
          if(mode==="human") await humanPause();
          const album=await fetchAlbumDetail(u, mode);
          await fs.writeFile(path.join(out,"albums",slug+".json"), JSON.stringify(album,null,2), "utf8");
          state.albums[u]={slug, fetched_at: album.fetched_at};
          fetchedOk++;
        }catch(e){
          fetchedFail++;
          const msg=String(e?.message||e);
          if(e?.code==="CHALLENGE" || msg.toLowerCase().includes("challenge")){
            blocked=true;
            warnings.push(`详情页疑似挑战/拦截，已停止继续抓取：${u}`);
          }else{
            warnings.push(`详情页抓取失败：${u} :: ${msg}`);
          }
          if(mode==="human") await sleep(randInt(3000,9000));
        }
      }
    });
    await Promise.all(workers);
    state.saved_at=DateTime.now().setZone(TZ).toISO();
    await saveState(statePath, state);
  }

  const summary={
    ok:true, source, mode, today,
    month_pages_discovered: monthPages.length,
    month_pages_used: used.length,
    schedule_count: schedule.length,
    urls_total: uniqueUrls.length,
    details_skipped_cached: skipped,
    details_fetched_ok: fetchedOk,
    details_fetched_failed: fetchedFail,
    blocked,
    refresh_days: refreshDays,
    output_dir: out,
    warnings
  };
  await fs.writeFile(path.join(out,"summary.json"), JSON.stringify(summary,null,2), "utf8");
  console.log(JSON.stringify(summary,null,2));
}

run().catch(e=>{ console.error(e); process.exit(1); });

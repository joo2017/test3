#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import minimist from "minimist";
import * as cheerio from "cheerio";
import { DateTime } from "luxon";

const SITE = "https://kpopofficial.com";
const CATEGORY_URL = "https://kpopofficial.com/category/kpop-comeback-schedule/";
const INDEX_URL = "https://kpopofficial.com/kpop-comebacks/";
const TZ_DEFAULT = "Asia/Seoul";

function sha256(s){ return crypto.createHash("sha256").update(s).digest("hex"); }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function cleanUrl(u){ try { const x = new URL(u); x.hash=""; return x.toString(); } catch { return u; } }
function home(){ return process.env.HOME || process.env.USERPROFILE || "."; }
function outDir(){ return process.env.KPOP_SCHEDULE_DIR || path.join(home(), ".openclaw", "kpop_schedule_strong"); }
async function ensureDir(p){ await fsp.mkdir(p, {recursive:true}); }
async function writeText(p, s){ await ensureDir(path.dirname(p)); await fsp.writeFile(p, s, "utf8"); }
async function writeJson(p, obj){ await ensureDir(path.dirname(p)); await fsp.writeFile(p, JSON.stringify(obj, null, 2), "utf8"); }
async function readJson(p, fb){ try { return JSON.parse(await fsp.readFile(p, "utf8")); } catch { return fb; } }

async function fetchHtml(url, {timeoutMs=25000, retries=2}={}){
  const headers={
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
      if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    }catch(e){
      last=e;
      await sleep(600*(i+1));
    }
  }
  throw last;
}

function extractMonthPageLinks(html, baseUrl){
  const $=cheerio.load(html);
  const links=new Set();
  $("a[href]").each((_,a)=>{
    const href=$(a).attr("href"); if(!href) return;
    const abs=cleanUrl(new URL(href, baseUrl).toString());
    if(abs.startsWith(SITE) && /kpop-comeback-schedule/i.test(abs)) links.add(abs);
  });
  return Array.from(links);
}
function findNextPageUrl(html, currentUrl){
  const $=cheerio.load(html);
  const next = $('link[rel="next"]').attr("href") || $('a[rel="next"]').attr("href");
  if(next) return cleanUrl(new URL(next, currentUrl).toString());
  if(!/\/page\/\d+\//.test(currentUrl)) return currentUrl.replace(/\/$/, "") + "/page/2/";
  const m=currentUrl.match(/\/page\/(\d+)\//);
  if(m){ return currentUrl.replace(/\/page\/\d+\//, `/page/${Number(m[1])+1}/`); }
  return null;
}

async function cmdDiscover({maxPages=6}){
  const out=outDir();
  await ensureDir(path.join(out, "raw", "monthly_index"));
  const pages=[]; const monthPages=new Set();
  const sources=[CATEGORY_URL, INDEX_URL];
  let sourceUsed=null;

  for(const source of sources){
    try{
      let url=source;
      for(let i=0;i<maxPages;i++){
        const html=await fetchHtml(url);
        pages.push(url);
        await writeText(path.join(out, "raw", "monthly_index", `index-${pages.length}.html`), html);
        for(const l of extractMonthPageLinks(html, url)) monthPages.add(l);

        if(source===INDEX_URL) break;
        const next=findNextPageUrl(html, url);
        if(!next || next===url) break;
        url=next;
        await sleep(250);
      }
      if(monthPages.size>0){ sourceUsed=source; break; }
    }catch(e){
      await writeText(path.join(out, "raw", "monthly_index", `error-${sha256(source).slice(0,8)}.txt`), String(e));
      continue;
    }
  }

  const month_pages=[...monthPages];
  month_pages.sort();

  const obj={discovered_at: DateTime.now().toISO(), source_used: sourceUsed, sources_tried: sources, pages_scanned: pages, month_pages};
  await writeJson(path.join(out, "month_pages.json"), obj);
  return obj;
}

// ----- event extraction (same as v1, condensed) -----
const MONTHS={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
function inferYearFromMonthlyTitle(html){
  const $=cheerio.load(html);
  const title=(($("h1").first().text()||$("title").text()||"").replace(/\s+/g," ").trim());
  const m=title.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b\s+(\d{4})/i);
  if(m) return {year:Number(m[2]), title};
  return {year:null, title};
}
function parseMainDateText(dateText, yearHint){
  const t=(dateText||"").replace(/\s+/g," ").trim();
  const m=t.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b\s+(\d{1,2})/i);
  if(!m) return null;
  const month=MONTHS[m[1].toLowerCase()], day=Number(m[2]), year=yearHint||DateTime.now().year;
  let zone=TZ_DEFAULT;
  const tzHint=t.match(/\b(KST|JST|UTC|GMT)\b/i)?.[1]?.toUpperCase();
  if(tzHint==="JST") zone="Asia/Tokyo";
  if(tzHint==="UTC"||tzHint==="GMT") zone="UTC";
  let dt=DateTime.fromObject({year,month,day,hour:0,minute:0},{zone});
  const tm=t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i);
  if(tm){
    let hh=Number(tm[1]); const mm=tm[2]?Number(tm[2]):0; const ap=tm[3].toUpperCase();
    if(ap==="PM"&&hh<12) hh+=12; if(ap==="AM"&&hh===12) hh=0;
    dt=dt.set({hour:hh,minute:mm});
    return {raw:t,precision:"datetime",tz:zone,iso:dt.toISO(),date:dt.toISODate(),time:dt.toFormat("HH:mm")};
  }
  return {raw:t,precision:"date",tz:zone,iso:dt.toISODate(),date:dt.toISODate(),time:null};
}
function parseMonthDayShort(text, yearHint){
  const t=(text||"").replace(/\s+/g," ").trim();
  const m=t.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)\b\.?\s+(\d{1,2})/i);
  if(!m) return null;
  let key=m[1].toLowerCase();
  const map3={jan:"january",feb:"february",mar:"march",apr:"april",jun:"june",jul:"july",aug:"august",sep:"september",sept:"september",oct:"october",nov:"november",dec:"december"};
  if(map3[key]) key=map3[key];
  const month=MONTHS[key], day=Number(m[2]), year=yearHint||DateTime.now().year;
  const dt=DateTime.fromObject({year,month,day},{zone:TZ_DEFAULT});
  return {date:dt.toISODate(), raw:t};
}
function extractEventsFromDateRaw(dateRaw, yearHint, mainDetail){
  const events=[];
  if(mainDetail?.date) events.push({event_kind:"release",event_date_iso:mainDetail.date,event_time:mainDetail.time,event_tz:mainDetail.tz||TZ_DEFAULT,event_raw_text:dateRaw});
  const t=(dateRaw||"").replace(/\s+/g," ").trim();
  const pre=t.match(/Pre-?release\s*[:·-]\s*([A-Za-z]{3,9}\.?\s+\d{1,2})/i);
  if(pre){ const d=parseMonthDayShort(pre[1],yearHint); if(d) events.push({event_kind:"pre_release",event_date_iso:d.date,event_time:null,event_tz:TZ_DEFAULT,event_raw_text:`Pre-release: ${d.raw}`}); }
  const ar=t.match(/Album Release\s*[:·-]\s*([A-Za-z]{3,9}\.?\s+\d{1,2})/i);
  if(ar){ const d=parseMonthDayShort(ar[1],yearHint); if(d) events.push({event_kind:"album_release",event_date_iso:d.date,event_time:null,event_tz:TZ_DEFAULT,event_raw_text:`Album Release: ${d.raw}`}); }
  return events;
}
function normalizeLinesFromElement($el){
  const text=$el.text().replace(/\r/g,"").split("\n").map(x=>x.replace(/\s+/g," ").trim()).filter(Boolean);
  const out=[]; for(const line of text){ if(!out.length||out[out.length-1]!==line) out.push(line); }
  return out;
}
function findCardContainer($, $a){
  let cur=$a;
  for(let i=0;i<8;i++){
    const parent=cur.parent(); if(!parent||!parent.length) break;
    const lines=normalizeLinesFromElement(parent);
    const hasMonth=lines.some(l=>/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(l));
    if(hasMonth && lines.length>=3) return parent;
    cur=parent;
  }
  const article=$a.closest("article, li, div");
  return article && article.length ? article : $a.parent();
}
function parseCardLinesToFields(lines){
  let dateIdx=lines.findIndex(l=>/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(l));
  if(dateIdx<0) dateIdx=0;
  const date_raw=lines[dateIdx]||"";
  let artist_raw=""; const info_lines=[];
  for(let i=dateIdx+1;i<lines.length;i++){
    const l=lines[i];
    if(!artist_raw && l && !/views?/i.test(l) && !/^https?:\/\//i.test(l)){ artist_raw=l; continue; }
    if(l && !/views?/i.test(l) && !/^https?:\/\//i.test(l)) info_lines.push(l);
  }
  return {date_raw, artist_raw, info_lines: info_lines.slice(0,4)};
}

async function cmdEvents({months=6}){
  const out=outDir();
  await ensureDir(path.join(out,"raw","monthly"));
  const mp=await readJson(path.join(out,"month_pages.json"), null);
  if(!mp?.month_pages?.length) throw new Error("month_pages.json not found. Run discover first.");
  const pages=mp.month_pages.slice(0, Math.max(1, Number(months)||6));
  const now=DateTime.now().setZone(TZ_DEFAULT);
  const eventsByKey=new Map();
  const entitiesSeed=new Map();

  for(let i=0;i<pages.length;i++){
    const pageUrl=pages[i];
    const html=await fetchHtml(pageUrl);
    await writeText(path.join(out,"raw","monthly",`month-${i+1}.html`), html);
    const {year}=inferYearFromMonthlyTitle(html);
    const yearHint=year||now.year;
    const $=cheerio.load(html);

    const albumLinks=[];
    $("a[href]").each((_,a)=>{
      const href=$(a).attr("href"); if(!href) return;
      const abs=cleanUrl(new URL(href, pageUrl).toString());
      if(/^https?:\/\/kpopofficial\.com\/album\/.+/i.test(abs)) albumLinks.push({abs, el:a});
    });

    const seen=new Set();
    for(const {abs, el} of albumLinks){
      if(seen.has(abs)) continue;
      seen.add(abs);
      const $a=$(el);
      const $card=findCardContainer($, $a);
      const lines=normalizeLinesFromElement($card);
      const {date_raw, artist_raw, info_lines}=parseCardLinesToFields(lines);
      const main=parseMainDateText(date_raw, yearHint);
      const expanded=extractEventsFromDateRaw(date_raw, yearHint, main);
      const entity_key=abs;
      if(!entitiesSeed.has(entity_key)){
        entitiesSeed.set(entity_key, {entity_key, detail_url:abs, artist_raw:artist_raw||null, info_raw: info_lines.join(" | ")||null, first_seen_page:pageUrl, raw_lines: lines.slice(0,10)});
      }
      const evList = expanded.length ? expanded : [{event_kind:"unknown",event_date_iso:main?.date||null,event_time:main?.time||null,event_tz:main?.tz||TZ_DEFAULT,event_raw_text:date_raw}];
      for(const ev of evList){
        const key = ev.event_date_iso
          ? sha256(`${entity_key}|${ev.event_kind}|${ev.event_date_iso}|${ev.event_time||""}|${ev.event_tz||""}`)
          : sha256(`${entity_key}|${ev.event_kind}|TBD|${ev.event_raw_text||""}`);
        const obj = eventsByKey.get(key) || {event_key:key, entity_key, detail_url:abs, event_kind:ev.event_kind, event_date_iso:ev.event_date_iso||null, event_time:ev.event_time||null, event_tz:ev.event_tz||TZ_DEFAULT, event_raw_text:ev.event_raw_text||"", sources:[]};
        obj.sources.push({page:pageUrl});
        eventsByKey.set(key,obj);
      }
    }
    await sleep(300);
  }

  const events=[...eventsByKey.values()].sort((a,b)=>String(a.event_date_iso||"9999-99-99").localeCompare(String(b.event_date_iso||"9999-99-99")));
  const entities_seed=[...entitiesSeed.values()];
  await writeJson(path.join(out,"events.json"), {generated_at: now.toISO(), months_used: pages.length, events});
  await writeJson(path.join(out,"entities_seed.json"), {generated_at: now.toISO(), months_used: pages.length, entities_seed});
  return {events_count: events.length, entities_seed_count: entities_seed.length};
}

// Enrich/views/delta omitted for brevity in this v2 packaging: they remain identical to v1 except fetchHtml headers.
// To keep this patch concise, v2 supports run that stops after events unless you already have v1 enrich.
async function main(){
  const argv=minimist(process.argv.slice(2), {default:{months:6, "max-pages":6}});
  const cmd=(argv._[0]||"run").toLowerCase();
  const out=outDir();
  await ensureDir(out);

  if(cmd==="discover"){ const r=await cmdDiscover({maxPages:Number(argv["max-pages"]||6)}); console.log(JSON.stringify({cmd,out,source_used:r.source_used,month_pages:r.month_pages.length},null,2)); return; }
  if(cmd==="events"){ const r=await cmdEvents({months:Number(argv.months||6)}); console.log(JSON.stringify({cmd,out,...r},null,2)); return; }
  if(cmd==="run"){
    const r=await cmdDiscover({maxPages:Number(argv["max-pages"]||6)});
    const e=await cmdEvents({months:Number(argv.months||6)});
    console.log(JSON.stringify({cmd,out,source_used:r.source_used,month_pages:r.month_pages.length,...e},null,2));
    return;
  }
  console.error("Unknown command. Use: discover|events|run");
  process.exit(2);
}
main().catch(e=>{ console.error(`[kpop_schedule_strong] ERROR: ${e?.stack||e}`); process.exit(1); });

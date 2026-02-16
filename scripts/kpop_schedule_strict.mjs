#!/usr/bin/env node
import { DateTime } from "luxon";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";

const SITE = "https://kpopofficial.com/kpop-comebacks/";
const TZ = "Asia/Seoul";

function home(){ return process.env.HOME || "."; }
function outDir(){ return path.join(home(), ".openclaw", "kpop_schedule_strict"); }

async function ensureDir(p){ await fs.mkdir(p, {recursive:true}); }

async function fetchHtml(url){
  const res = await fetch(url, {
    headers: {
      "user-agent":"Mozilla/5.0",
      "accept":"text/html"
    }
  });
  if(!res.ok) throw new Error("HTTP "+res.status);
  return await res.text();
}

function parseDate(text){
  const m = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s*(\d{4})?/i);
  if(!m) return { display:"待定（未公布具体日期）", iso:null };
  const monthMap = {
    january:1,february:2,march:3,april:4,may:5,june:6,
    july:7,august:8,september:9,october:10,november:11,december:12
  };
  const month = monthMap[m[1].toLowerCase()];
  const day = Number(m[2]);
  const year = m[3] ? Number(m[3]) : DateTime.now().year;
  const dt = DateTime.fromObject({year,month,day},{zone:TZ});
  return {
    display: dt.toISODate(),
    iso: dt.toISODate()
  };
}

async function run(){
  const out = outDir();
  await ensureDir(out);
  const html = await fetchHtml(SITE);
  const $ = cheerio.load(html);

  const today = DateTime.now().setZone(TZ).toISODate();
  const results = [];

  $("li.gspbgrid_item").each((_,li)=>{
    const card = $(li);
    const link = card.find("a[href*='/album/']").first().attr("href");
    if(!link) return;

    const meta = [];
    card.find(".gspb_meta_value").each((_,el)=>{
      meta.push($(el).text().trim());
    });

    const dateText = meta.find(t=>/January|February|March|April|May|June|July|August|September|October|November|December/i.test(t)) || "";
    const artist = meta.find(t=>!/January|February|March|April|May|June|July|August|September|October|November|December|EP|Album|Single|OST/i.test(t)) || "";
    const title = meta.find(t=>/EP|Album|Single|OST/i.test(t)) || "";

    const parsed = parseDate(dateText);

    if(parsed.iso && parsed.iso < today){
      return;
    }

    results.push({
      回归日期: parsed.display,
      艺人: artist || "待定（未公布具体信息）",
      专辑名: title || "待定（未公布具体信息）",
      详情链接: link
    });
  });

  await fs.writeFile(path.join(out,"schedule.json"), JSON.stringify(results,null,2),"utf8");
  console.log(JSON.stringify({ok:true, count:results.length, output:path.join(out,"schedule.json")},null,2));
}

run().catch(e=>{
  console.error(e);
  process.exit(1);
});

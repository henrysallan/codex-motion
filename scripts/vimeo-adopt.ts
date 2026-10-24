// Folds videos fetched by scripts/vimeo-retry.sh back into their site's scrape,
// as if the scraper had downloaded them: each <vimeo id>.<ext> in
// media/vimeo-retry/<site>/ is matched to the failed `vimeo:<id>` item in
// media/scraped/<site>/scrape.json, probed, hashed, moved in as <hash>.<ext>
// with its sidecar, and given yt-dlp's metadata. Failed items missed the
// page's enrichment, so they take the project info of a video from the same
// page. Afterwards, build-proxies --merge on the site adds them to the library.
//
//   node scripts/vimeo-adopt.ts [site ...]      (default: every folder in media/vimeo-retry)

import fs from 'node:fs';
import path from 'node:path';
import { hashFile, probe } from './lib/media.ts';
import { applyEmbedInfo, titleFromEmbed } from './scrape/download.ts';
import type { ScrapedItem } from './scrape/types.ts';

const RETRY = 'media/vimeo-retry';
const sites = process.argv.slice(2).length ? process.argv.slice(2) : fs.existsSync(RETRY) ? fs.readdirSync(RETRY).filter((d) => fs.statSync(path.join(RETRY, d)).isDirectory()) : [];

for (const site of sites) {
  const from = path.join(RETRY, site);
  const dir = path.join('media/scraped', site);
  const manifestPath = path.join(dir, 'scrape.json');
  if (!fs.existsSync(manifestPath)) {
    console.log(`${site}: no ${manifestPath}; skipped`);
    continue;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { items: ScrapedItem[]; stats?: Record<string, unknown> };
  const byKey = new Map(manifest.items.map((i) => [i.key, i]));
  // Project info by page, from items that went through enrichment.
  const projectOn = new Map<string, ScrapedItem['project']>();
  for (const i of manifest.items) if (i.project && !projectOn.has(i.page.url)) projectOn.set(i.page.url, i.project);

  let adopted = 0;
  let already = 0;
  let unmatched = 0;
  for (const f of fs.readdirSync(from)) {
    const m = /^(\d+)\.(mp4|mkv|webm)$/.exec(f);
    if (!m) continue;
    const item = byKey.get(`vimeo:${m[1]}`);
    if (!item) {
      unmatched++;
      continue;
    }
    if (item.status === 'downloaded') {
      already++;
      continue;
    }
    const src = path.join(from, f);
    const p = await probe(src);
    const id = await hashFile(src);
    const file = `${id}.${m[2]}`;
    const dest = path.join(dir, file);
    if (fs.existsSync(dest)) fs.rmSync(src);
    else fs.renameSync(src, dest);
    item.status = 'downloaded';
    delete item.reason;
    item.id = id;
    item.file = file;
    Object.assign(item.media, {
      downloadedFrom: `https://player.vimeo.com/video/${m[1]}`,
      bytes: fs.statSync(dest).size,
      width: p.width,
      height: p.height,
      duration: Number(p.duration.toFixed(3)),
      fps: Number(p.fps.toFixed(3)),
      ...(p.codec ? { codec: p.codec } : {}),
      audio: p.audio,
    });
    const infoPath = path.join(from, `${m[1]}.info.json`);
    if (fs.existsSync(infoPath)) {
      applyEmbedInfo(item, JSON.parse(fs.readFileSync(infoPath, 'utf8')) as Record<string, unknown>);
      fs.rmSync(infoPath);
    }
    titleFromEmbed(item);
    item.project ??= projectOn.get(item.page.url);
    const sidecarPath = path.join(dir, `${id}.json`);
    if (!fs.existsSync(sidecarPath)) fs.writeFileSync(sidecarPath, JSON.stringify(item, null, 2));
    adopted++;
  }
  if (adopted && manifest.stats) {
    manifest.stats.downloaded = manifest.items.filter((i) => i.status === 'downloaded').length;
    manifest.stats.failed = manifest.items.filter((i) => i.status === 'failed').length;
  }
  if (adopted) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`${site}: ${adopted} adopted${already ? `, ${already} already downloaded` : ''}${unmatched ? `, ${unmatched} with no matching item` : ''}`);
}

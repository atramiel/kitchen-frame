// Photos from an iCloud shared album (the same public link DAKboard used).
// The album listing is slow (~50 s for 1,500 items), so it's cached and
// refreshed hourly in the background. Images are resized with sharp to the
// photo area and cached on disk by checksum.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

type Photo = { guid: string; checksum: string; width: number; height: number; taken?: string };

type Size = { width: number; height: number };

export function createIcloudAlbum(root: string, token: string) {
  const cacheDir = join(root, "cache", "photos");
  mkdirSync(cacheDir, { recursive: true });
  const listFile = join(root, "cache", "album.json");
  let host = "p23-sharedstreams.icloud.com";
  let photos: Photo[] = existsSync(listFile) ? JSON.parse(readFileSync(listFile, "utf8")) : [];
  let order: number[] = [];

  async function call(path: string, body: unknown): Promise<any> {
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`https://${host}/${token}/sharedstreams/${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      // 330 = wrong partition; iCloud names the right host in a header.
      if (res.status === 330) { host = res.headers.get("x-apple-mme-host") ?? host; continue; }
      if (!res.ok) throw new Error(`iCloud ${path}: ${res.status}`);
      return res.json();
    }
    throw new Error(`iCloud ${path}: redirect loop`);
  }

  async function refresh() {
    const d = await call("webstream", { streamCtag: null });
    photos = (d.photos as any[])
      .filter((p) => p.mediaAssetType !== "video")
      .map((p) => {
        // Largest derivative; shared albums top out around 2K.
        const best = Object.values(p.derivatives as Record<string, any>)
          .sort((a: any, b: any) => Number(b.width) - Number(a.width))[0] as any;
        return { guid: p.photoGuid, checksum: best.checksum, width: Number(best.width), height: Number(best.height), taken: p.dateCreated };
      });
    writeFileSync(listFile, JSON.stringify(photos));
    order = [];
    console.log(`iCloud album: ${photos.length} photos`);
  }

  function nextPhoto(): Photo | undefined {
    if (!photos.length) return;
    if (!order.length) order = [...photos.keys()].sort(() => Math.random() - 0.5); // shuffle, no repeats per pass
    return photos[order.pop()!];
  }

  async function image(p: Photo, size: Size): Promise<Buffer> {
    const file = join(cacheDir, `${p.checksum}-${size.width}x${size.height}.jpg`);
    if (existsSync(file)) return readFileSync(file);
    const urls = await call("webasseturls", { photoGuids: [p.guid] });
    const item = urls.items[p.checksum];
    if (!item) throw new Error(`no URL for ${p.guid}`);
    const res = await fetch(`https://${item.url_location}${item.url_path}`);
    if (!res.ok) throw new Error(`download ${p.guid}: ${res.status}`);
    const out = await sharp(Buffer.from(await res.arrayBuffer()))
      .rotate() // honour EXIF orientation
      .resize(size.width, size.height, { fit: "cover", position: sharp.strategy.attention, withoutEnlargement: false })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
    writeFileSync(file, out);
    return out;
  }

  refresh().catch((e) => console.error("iCloud album:", e.message));
  setInterval(() => refresh().catch((e) => console.error("iCloud album:", e.message)), 60 * 60 * 1000);

  return {
    count: () => photos.length,
    // The image plus when it was taken (iCloud's dateCreated, the capture time).
    async next(size: Size): Promise<{ img: Buffer; taken?: string } | undefined> {
      for (let tries = 0; tries < 3; tries++) {
        const p = nextPhoto();
        if (!p) return;
        try { return { img: await image(p, size), taken: p.taken }; } catch (e) { console.error("photo:", (e as Error).message); }
      }
    },
  };
}

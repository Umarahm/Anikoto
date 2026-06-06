import * as cheerio from 'cheerio';
import { fetchJson } from '../fetcher';
import { scrapeAnimeEpisodes } from './anime.scraper';
import { Episode } from '../types';
import { extractStreamUrl, SubtitleTrack } from '../extractors';

export interface VideoServer {
  id: string; // linkId
  name: string; // server name (e.g. Vidstreaming, MegaCloud)
  type: string; // "sub" | "dub" | "softsub"
}

export interface VideoTrack extends SubtitleTrack {
  proxyUrl?: string;
}

export interface VideoSource {
  server: string;
  type: string; // "sub" | "dub" | "softsub"
  url: string; // The iframe/embed URL
  m3u8?: string | null; // Extracted m3u8 direct link
  referer?: string; // Required referer for the m3u8 stream
  proxyUrl?: string | null; // The URL to proxy the stream through our backend
  tracks?: VideoTrack[];
}

export interface WatchData {
  episode: Episode;
  servers: VideoServer[];
  sources: VideoSource[];
}

/** Cap individual server fetch+extraction so a single slow server can't block everything. */
const SERVER_TIMEOUT_MS = 6000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms (${label})`)), ms)
    ),
  ]);
}

export async function scrapeWatch(slug: string, epNum: string): Promise<WatchData> {
  const { episodes } = await scrapeAnimeEpisodes(slug);
  const ep = episodes.find((e) => e.number === epNum);

  if (!ep || !ep.dataIds) {
    throw new Error(`Episode ${epNum} not found or has no data-ids for slug ${slug}`);
  }

  // 1. Fetch server list
  const listData = await fetchJson<{ status: boolean; result: string }>(
    `/ajax/server/list?servers=${ep.dataIds}`
  );

  if (!listData.status || !listData.result) {
    throw new Error('Failed to fetch server list from AJAX');
  }

  const $ = cheerio.load(listData.result);
  const servers: VideoServer[] = [];

  $('.server, li').each((_, el) => {
    const $el = $(el);
    const linkId = $el.attr('data-link-id');
    if (!linkId) return;

    const $typeContainer = $el.closest('.type');
    const typeLabel = $typeContainer.find('label, .name').text().trim().toLowerCase();
    const serverName = $el.text().trim();

    servers.push({
      id: linkId,
      name: serverName,
      type: typeLabel || 'sub',
    });
  });

  // Helper to generate proxy URLs using either Cloudflare Worker or internal Next.js proxy
  const getProxyUrl = (targetUrl: string, referer?: string) => {
    const rawBaseUrl = process.env.NEXT_PUBLIC_CF_WORKER_URL || process.env.CF_WORKER_URL || '/api/proxy';
    const baseUrl = rawBaseUrl.trim();
    const separator = baseUrl.includes('?') ? '&' : '?';
    const urlParam = `url=${encodeURIComponent(targetUrl)}`;
    const refererParam = referer ? `&referer=${encodeURIComponent(referer)}` : '';
    
    if (baseUrl.endsWith('/')) {
      return `${baseUrl}?${urlParam}${refererParam}`;
    }
    return `${baseUrl}${separator}${urlParam}${refererParam}`;
  };

  // 2. Fetch embed URL + extract m3u8 for all servers in parallel.
  //    Each server is individually capped at SERVER_TIMEOUT_MS so a single
  //    slow/unreachable server cannot stall the entire response.
  const sources: VideoSource[] = [];

  await Promise.all(
    servers.map(async (server) => {
      try {
        await withTimeout(
          (async () => {
            const sourceData = await fetchJson<{ status: boolean; result: { url: string } }>(
              `/ajax/server?get=${server.id}`
            );
            if (sourceData.status && sourceData.result?.url) {
              const embedUrl = sourceData.result.url;
              // 3. Extract the actual m3u8 stream link and referer
              const extracted = await extractStreamUrl(embedUrl);

              sources.push({
                server: server.name,
                type: server.type,
                url: embedUrl,
                m3u8: extracted?.m3u8 ?? null,
                referer: extracted?.referer,
                proxyUrl: extracted?.m3u8 ? getProxyUrl(extracted.m3u8, extracted.referer) : null,
                tracks: extracted?.tracks?.map(t => ({
                  ...t,
                  proxyUrl: getProxyUrl(t.file, extracted.referer)
                })) || [],
              });
            }
          })(),
          SERVER_TIMEOUT_MS,
          server.name
        );
      } catch (err) {
        console.error(`Skipping server ${server.name} (${server.id}):`, err instanceof Error ? err.message : err);
      }
    })
  );

  return {
    episode: ep,
    servers,
    sources,
  };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import * as icons from 'simple-icons';

const outDir = path.resolve('asset_sources/raw');

const remoteLogos = [
  {
    id: 'logo-openai',
    url: 'https://upload.wikimedia.org/wikipedia/commons/6/66/OpenAI_logo_2025_%28symbol%29.svg',
    color: '#0f0f0f',
  },
  {
    id: 'logo-grok',
    url: 'https://unpkg.com/@lobehub/icons-static-svg@latest/icons/grok.svg',
    color: '#0f0f0f',
  },
];

const simpleLogos = [
  { id: 'logo-gemini', icon: icons.siGooglegemini, color: `#${icons.siGooglegemini.hex}` },
  { id: 'logo-claude', icon: icons.siClaude, color: `#${icons.siClaude.hex}` },
  { id: 'logo-deepseek', icon: icons.siDeepseek, color: `#${icons.siDeepseek.hex}` },
];

function colorize(svg, color) {
  return svg
    .replace(/<title>.*?<\/title>/g, '')
    .replace(/<path /g, `<path fill="${color}" `)
    .replace(/<circle /g, `<circle fill="${color}" `)
    .replace(/<rect /g, `<rect fill="${color}" `);
}

async function renderSvg(id, svg, padding = 34) {
  const paddedSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
      <rect width="512" height="512" fill="none"/>
      <g transform="translate(${padding} ${padding}) scale(${(512 - padding * 2) / 24})">
        ${svg
          .replace(/<svg[^>]*>/, '')
          .replace(/<\/svg>/, '')
          .trim()}
      </g>
    </svg>`;

  await sharp(Buffer.from(paddedSvg)).png().toFile(path.join(outDir, `${id}.png`));
}

await fs.mkdir(outDir, { recursive: true });

for (const logo of simpleLogos) {
  await renderSvg(logo.id, colorize(logo.icon.svg, logo.color), logo.id === 'logo-gemini' ? 42 : 34);
}

for (const logo of remoteLogos) {
  const response = await fetch(logo.url, {
    headers: { 'user-agent': 'CodexAssetBuilder/1.0' },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${logo.url}: ${response.status}`);
  }
  const svg = colorize(await response.text(), logo.color);
  await sharp(Buffer.from(svg))
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(outDir, `${logo.id}.png`));
}

import fs from 'fs';
import path from 'path';

function hexToRgb(hex) {
  hex = hex.replace(/^#/, '');
  if (hex.length === 3) {
    hex = hex.split('').map(c => c + c).join('');
  }
  const num = parseInt(hex, 16);
  return [num >> 16, (num >> 8) & 255, num & 255];
}

function luminance(r, g, b) {
  const a = [r, g, b].map(v => {
    v /= 255;
    return v <= 0.03928
      ? v / 12.92
      : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

function contrast(hex1, hex2) {
  const rgb1 = hexToRgb(hex1);
  const rgb2 = hexToRgb(hex2);
  const l1 = luminance(rgb1[0], rgb1[1], rgb1[2]);
  const l2 = luminance(rgb2[0], rgb2[1], rgb2[2]);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

const tokensPath = path.join(process.cwd(), 'src', 'design-system', 'styles', 'tokens.css');
const css = fs.readFileSync(tokensPath, 'utf8');

// parse tokens
const lightTokens = {};
const darkTokens = {};

let currentScheme = lightTokens;
const lines = css.split('\n');
for (const line of lines) {
  if (line.includes('@media (prefers-color-scheme: dark)')) {
    currentScheme = darkTokens;
  }
  const match = line.match(/(--color-[a-z-]+):\s*(#[a-fA-F0-9]+)/);
  if (match) {
    currentScheme[match[1]] = match[2];
  }
}

// Fallback dark tokens if not defined
for (const k in lightTokens) {
  if (!darkTokens[k]) {
    darkTokens[k] = lightTokens[k];
  }
}

const textTokens = Object.keys(lightTokens).filter(k => k.startsWith('--color-text-') && k !== '--color-text-inverse');
const bgTokens = Object.keys(lightTokens).filter(k => k.startsWith('--color-bg-'));

const pairsToCheck = [];
for (const t of textTokens) {
  for (const b of bgTokens) {
    pairsToCheck.push([t, b]);
  }
}

let failed = false;

function checkScheme(scheme, schemeName) {
  for (const [textToken, bgToken] of pairsToCheck) {
    const textHex = scheme[textToken];
    const bgHex = scheme[bgToken];
    if (!textHex || !bgHex) continue;
    const ratio = contrast(textHex, bgHex);
    if (ratio < 4.5) {
      console.error(`FAIL: ${schemeName} ${textToken} (${textHex}) vs ${bgToken} (${bgHex}) = ${ratio.toFixed(2)}`);
      failed = true;
    } else {
      console.log(`PASS: ${schemeName} ${textToken} vs ${bgToken} = ${ratio.toFixed(2)}`);
    }
  }
}

checkScheme(lightTokens, 'Light');
checkScheme(darkTokens, 'Dark');

if (failed) {
  process.exit(1);
}
console.log('All pairs pass!');
process.exit(0);

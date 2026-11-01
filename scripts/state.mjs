/** The record of what scripts/deploy.mjs created (.deploy/state.json, gitignored). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.mjs';

export const STATE_FILE = join(ROOT, '.deploy/state.json');

export function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

export function saveState(state) {
  mkdirSync(join(ROOT, '.deploy'), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

/** Removes // and /* *\/ comments outside of strings, and trailing commas, from JSONC. */
export function stripJsonComments(text) {
  let output = '';
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      output += char;
      if (char === '\\') {
        output += next ?? '';
        index++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      output += '\n';
    } else if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
      index++;
    } else {
      output += char;
    }
  }
  return output.replace(/,(\s*[}\]])/g, '$1');
}

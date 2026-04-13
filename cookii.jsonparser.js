/**
 * 在 jsonrepair 之前做常见预处理，再 JSON.parse。
 * 可选依赖同目录 `jsonrepair.js`（UMD，挂到 globalThis.JSONRepair）；
 * 未加载时仅用预处理后的字符串 JSON.parse（与 immersive-ractive 行为一致）。
 */
// import './jsonrepair.js';

/** @type {((s: string) => string) | null} */
var repairFn =
  typeof globalThis.JSONRepair !== 'undefined' && globalThis.JSONRepair
    ? globalThis.JSONRepair.jsonrepair
    : null;

/** 仅去掉开头的 UTF-8 BOM（\uFEFF），避免 jsonrepair 把 BOM 当成非法字符 */
function stripLeadingBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 从首个 `{` 或 `[` 起截取到与之平衡的第一个顶层值（忽略字符串内的括号）。
 * 用于：`{"a":1}垃圾`、`{"a":1}{"b":2}` 只取第一段。
 * 若未找到括号则返回原文，交给 jsonrepair。
 */
function extractFirstBalancedJson(s) {
  const start = s.search(/[{\[]/);
  if (start === -1) return s;
  const stack = [];
  const first = s[start];
  stack.push(first === '{' ? '}' : ']');
  let i = start + 1;
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inDouble) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c === "'") inSingle = false;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '{') {
      stack.push('}');
      continue;
    }
    if (c === '[') {
      stack.push(']');
      continue;
    }
    if ((c === '}' || c === ']') && stack.length && stack[stack.length - 1] === c) {
      stack.pop();
      if (stack.length === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start);
}

/** 在字符串外把连续 `,`（及中间空白）压成单个 `,`，修复 `{"a":1,, "b":2}` */
function collapseDuplicateCommasOutsideStrings(s) {
  let out = '';
  let i = 0;
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  while (i < s.length) {
    const c = s[i];
    if (inDouble) {
      out += c;
      if (escaped) {
        escaped = false;
        i++;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      i++;
      continue;
    }
    if (inSingle) {
      out += c;
      if (escaped) {
        escaped = false;
        i++;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        i++;
        continue;
      }
      if (c === "'") inSingle = false;
      i++;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      out += c;
      i++;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      out += c;
      i++;
      continue;
    }
    if (c === ',') {
      out += ',';
      i++;
      while (i < s.length && ' \t\n\r'.includes(s[i])) {
        out += s[i];
        i++;
      }
      while (i < s.length && s[i] === ',') {
        i++;
        while (i < s.length && ' \t\n\r'.includes(s[i])) {
          i++;
        }
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 在字符串外把 `: +数字` 改成 `: 数字`（JSON 不允许一元 +） */
function removeUnaryPlusAfterColonOutsideStrings(s) {
  let out = '';
  let i = 0;
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  while (i < s.length) {
    const c = s[i];
    if (inDouble) {
      out += c;
      if (escaped) {
        escaped = false;
        i++;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      i++;
      continue;
    }
    if (inSingle) {
      out += c;
      if (escaped) {
        escaped = false;
        i++;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        i++;
        continue;
      }
      if (c === "'") inSingle = false;
      i++;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      out += c;
      i++;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      out += c;
      i++;
      continue;
    }
    if (c === ':') {
      out += c;
      i++;
      while (i < s.length && ' \t\n\r'.includes(s[i])) {
        out += s[i];
        i++;
      }
      if (i < s.length && s[i] === '+' && i + 1 < s.length && /[0-9]/.test(s[i + 1])) {
        i++;
        continue;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 预处理 + jsonrepair + JSON.parse。空串返回 `null`。
 * 连续多段 JSON 时只解析**第一段**平衡值（与「取第一个对象」的常见需求一致）。
 *
 * @param {unknown} raw
 * @returns {null | unknown}
 */
function cookiiJsonParser(raw) {
  let s = stripLeadingBom(String(raw)).trim();
  if (s === '') return null;
  s = extractFirstBalancedJson(s);
  s = collapseDuplicateCommasOutsideStrings(s);
  s = removeUnaryPlusAfterColonOutsideStrings(s);
  const repaired = repairFn ? repairFn(s) : s;
  return JSON.parse(repaired);
}

if (typeof globalThis !== 'undefined') {
  globalThis.cookiiJsonParser = cookiiJsonParser;
}

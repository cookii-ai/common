/**
 * 在 jsonrepair 之前做常见预处理，再 JSON.parse。
 * 含：值字符串内未转义的双引号、值开头笔误 `""`、值内 `\\"` 过度转义的修复（见 repairUnescapedDoubleQuotesInJsonValues）。
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

function isJsonWs(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

/**
 * s[i] 为刚写出的闭合 " 之后的下标（即字符串值结束后的第一个字符位置）。
 * 若为 JSON 中「本字段结束」则 true。
 * 注意：若仅为叙述里的 `..."对白", 下文`，逗号后是字母而非 `"`/`}`/`]`，则 false，避免把对白里的 ," 当成字段结尾。
 */
function isStructuralAfterQuote(s, i) {
  let j = i;
  while (j < s.length && isJsonWs(s[j])) j++;
  if (j >= s.length) return true;
  const ch = s[j];
  if (ch === '}' || ch === ']') return true;
  if (ch === ',') {
    j++;
    while (j < s.length && isJsonWs(s[j])) j++;
    if (j >= s.length) return true;
    const next = s[j];
    return next === '"' || next === '}' || next === ']';
  }
  return false;
}

/**
 * 第一个 " 前若是单词/中文/下划线/右括号，则连续 "" 多半是对白结束引号 + 下一字符，
 * 不是 JSON 字面量空串 ""（避免 `she says: "hi""` + `,` + `"nextKey"` 被误判为空串结束字段）。
 */
function isWordLikeBeforeQuote(c) {
  if (c === '_' || c === ')') return true;
  if (c >= 'a' && c <= 'z') return true;
  if (c >= 'A' && c <= 'Z') return true;
  if (c >= '0' && c <= '9') return true;
  const code = c.charCodeAt(0);
  return code >= 0x4e00 && code <= 0x9fff;
}

/** 与 isStructuralAfterQuote 相同规则，用于判断 "" 是否表示空串并结束当前 JSON 字符串值（i 为第一个 " 的下标） */
function isEmptyStringPairClosingValue(s, i) {
  if (i > 0 && isWordLikeBeforeQuote(s[i - 1])) {
    return false;
  }
  let j = i + 2;
  while (j < s.length && isJsonWs(s[j])) j++;
  if (j >= s.length) return true;
  if (s[j] === '}' || s[j] === ']') return true;
  if (s[j] === ',') {
    j++;
    while (j < s.length && isJsonWs(s[j])) j++;
    if (j >= s.length) return true;
    const next = s[j];
    return next === '"' || next === '}' || next === ']';
  }
  return false;
}

/**
 * 修复「值」里未转义或笔误的双引号，使 JSON.parse / jsonrepair 能处理。
 * - 仅在 key 已闭合、冒号后的双引号字符串值内扫描（含数组里的字符串值）。
 * - 若遇到 " 且其后（跳过空白）不是 , } ] 或结尾，则视为内容中的引号，输出 \"。
 * - 值刚开头若为 "" 且第三个非空白字符不是结构结束，则合并为单个 \"（多写一个 " 的常见笔误）。
 * - 连续 "" 是否视为 JSON 空串：若前一字符为字母/数字/中文/_/)，则不当作空串（避免 "hi"" 误判）。
 * - 值内若出现 \\"（过度转义），合并为 \"。
 */
function repairUnescapedDoubleQuotesInJsonValues(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  /** @type {{ type: 'obj'; keyExpected: boolean } | { type: 'arr' }} */
  const stack = [];
  /** @type {'OUT' | 'KEY_STR' | 'AFTER_KEY' | 'VAL_STR'} */
  let state = 'OUT';
  /** 进入 VAL_STR 后尚未写出任何「内容字符」时为 true（已写过 opening "） */
  let valAtStart = false;

  function top() {
    return stack[stack.length - 1];
  }

  while (i < n) {
    const c = s[i];

    if (state === 'KEY_STR') {
      out += c;
      if (c === '\\') {
        i++;
        if (i < n) {
          out += s[i];
          i++;
        }
        continue;
      }
      if (c === '"') {
        i++;
        state = 'AFTER_KEY';
        continue;
      }
      i++;
      continue;
    }

    if (state === 'AFTER_KEY') {
      if (isJsonWs(c)) {
        out += c;
        i++;
        continue;
      }
      if (c === ':') {
        out += c;
        i++;
        const t = top();
        if (t && t.type === 'obj') t.keyExpected = false;
        state = 'OUT';
        continue;
      }
      state = 'OUT';
      continue;
    }

    if (state === 'VAL_STR') {
      if (c === '"' && i + 1 < n && s[i + 1] === '"') {
        const closesEmpty = isEmptyStringPairClosingValue(s, i);
        if (closesEmpty) {
          out += '""';
          i += 2;
          state = 'OUT';
          continue;
        }
        if (valAtStart) {
          out += '\\"';
          i += 2;
          valAtStart = false;
          continue;
        }
      }
      valAtStart = false;

      if (c === '\\') {
        out += c;
        i++;
        if (i >= n) break;
        if (s[i] === '\\' && i + 1 < n && s[i + 1] === '"') {
          out += '"';
          i += 2;
        } else {
          out += s[i];
          i++;
        }
        continue;
      }
      if (c === '"') {
        if (isStructuralAfterQuote(s, i + 1)) {
          out += c;
          i++;
          state = 'OUT';
          continue;
        }
        out += '\\"';
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }

    if (state === 'OUT') {
      if (c === '{') {
        stack.push({ type: 'obj', keyExpected: true });
        out += c;
        i++;
        continue;
      }
      if (c === '}') {
        stack.pop();
        out += c;
        i++;
        continue;
      }
      if (c === '[') {
        stack.push({ type: 'arr' });
        out += c;
        i++;
        continue;
      }
      if (c === ']') {
        stack.pop();
        out += c;
        i++;
        continue;
      }
      if (c === ',') {
        const t = top();
        if (t && t.type === 'obj') t.keyExpected = true;
        out += c;
        i++;
        continue;
      }
      if (c === ':') {
        out += c;
        i++;
        continue;
      }
      if (c === '"') {
        const t = top();
        if (t && t.type === 'obj' && t.keyExpected) {
          out += c;
          i++;
          state = 'KEY_STR';
          continue;
        }
        if (t && t.type === 'obj' && !t.keyExpected) {
          out += c;
          i++;
          state = 'VAL_STR';
          valAtStart = true;
          continue;
        }
        if (t && t.type === 'arr') {
          out += c;
          i++;
          state = 'VAL_STR';
          valAtStart = true;
          continue;
        }
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
  }
  return out;
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
  s = repairUnescapedDoubleQuotesInJsonValues(s);
  s = extractFirstBalancedJson(s);
  s = collapseDuplicateCommasOutsideStrings(s);
  s = removeUnaryPlusAfterColonOutsideStrings(s);
  const repaired = repairFn ? repairFn(s) : s;
  return JSON.parse(repaired);
}

if (typeof globalThis !== 'undefined') {
  globalThis.cookiiJsonParser = cookiiJsonParser;
}

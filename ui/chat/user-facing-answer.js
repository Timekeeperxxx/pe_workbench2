/**
 * The post-answer check rewrites a draft the user has not seen. Models often
 * narrate that rewrite ("我上一轮…这不准确…修正后的完整回答"). That narration
 * is not the answer. Keep the substantive reply and drop the frame.
 */

const ANSWER_MARKER = /(?:^|\n)[ \t]*(?:#{1,3}[ \t]*)?(?:[（(]?[一二三四五六七八九十\d]+[)）.．、][ \t]*)?修正后的完整回答[^\n]*\n*/;

const CONFESSION = /我上一轮[^。\n]{0,180}(?:不准确|不对|有误)|下面逐项给出出处[，,]再给|此前说法[^。\n]{0,80}(?:不准确|需修正|有误)/;

function hasRepairFrame(text) {
  return /修正后的完整回答|我上一轮|下面逐项给出出处[，,]再给|此前说法/.test(text);
}

function isFrameOnly(paragraph) {
  const text = paragraph.trim();
  if (!text) return true;
  if (/^核验结果(?:[（(]|$)/.test(text)) return true;
  if (/^结论：\s*\d+\s*个待核/.test(text)) return true;
  if (/^[一二三四五六七八九十\d]+[、.．]\s*逐个数字的出处核验\s*$/.test(text)) return true;
  const sentences = text.split(/(?<=。)/).map((sentence) => sentence.trim()).filter(Boolean);
  return sentences.length > 0 && sentences.every((sentence) => CONFESSION.test(sentence));
}

export function presentUserAnswer(text) {
  const source = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!source || !hasRepairFrame(source)) return source;

  const marked = source.match(ANSWER_MARKER);
  let body = marked ? source.slice(marked.index + marked[0].length).trim() : source;
  if (marked && !body) return "";

  if (!marked) {
    const parts = body.split(/\n\n+/);
    let index = 0;
    while (index < parts.length && isFrameOnly(parts[index])) index += 1;
    body = parts.slice(index).join("\n\n").trim();
    if (!body) return "";
  }

  const cleaned = body
    .split(/(?<=。)/)
    .filter((sentence) => !CONFESSION.test(sentence))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || body;
}

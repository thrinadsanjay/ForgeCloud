/**
 * Lightweight markdown for Forge Assist replies: **bold**, `code`,
 * unordered/ordered lists, and paragraphs. Escapes HTML first.
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineFormat(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
}

export function chatTextToHtml(text) {
  const raw = String(text || "");
  if (!raw.trim()) return "";

  const lines = raw.split(/\r?\n/);
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);

    if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      const items = [];
      while (i < lines.length) {
        const m = tag === "ul"
          ? lines[i].match(/^\s*[-*]\s+(.+)$/)
          : lines[i].match(/^\s*\d+[.)]\s+(.+)$/);
        if (!m) break;
        items.push(`<li>${inlineFormat(escapeHtml(m[1]))}</li>`);
        i += 1;
      }
      blocks.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
      para.push(escapeHtml(lines[i]));
      i += 1;
    }
    blocks.push(`<p>${inlineFormat(para.join("<br/>"))}</p>`);
  }

  return blocks.join("");
}

export default function ChatMarkdown({ text, className }) {
  const html = chatTextToHtml(text);
  if (!html) return null;
  return (
    <div
      className={className ? `chat-md ${className}` : "chat-md"}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

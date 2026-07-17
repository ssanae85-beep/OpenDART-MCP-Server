/**
 * Parser for OpenDART disclosure documents (document.xml).
 *
 * DART filings are tag soup rather than strict XML — unescaped entities and
 * unclosed elements are common — so this uses tolerant scanning instead of a
 * real XML parser, which would reject whole documents over minor defects.
 */

/**
 * Elements that establish document hierarchy. A TITLE's depth is the stack
 * depth where it appears.
 *
 * DOCUMENT/BODY/LIBRARY are deliberately excluded. LIBRARY is a layout
 * container, not a heading level, and filings nest it freely — 삼성전자's
 * 사업보고서 opens 27 of them. Counting it made every title after a nested
 * LIBRARY look one level deeper, which put 연결재무제표 and the notes *inside*
 * 요약재무정보 and stretched that section to 4.4M chars.
 */
const STRUCTURAL_TAGS = new Set([
  "PART",
  "SECTION-1",
  "SECTION-2",
  "SECTION-3",
  "SECTION-4",
]);

const TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9-]*)([^>]*?)(\/?)>/g;

export interface DocSection {
  /** 1-based position in the table of contents */
  index: number;
  /** Nesting level relative to the shallowest title, 0 = top */
  depth: number;
  title: string;
  /** Offset of this section's <TITLE> tag; where the previous section ends */
  titleStart: number;
  /** Offset in the raw document where this section's body starts (after </TITLE>) */
  start: number;
  /** Offset where this section ends (exclusive); includes nested subsections */
  end: number;
}

export interface ParsedDocument {
  docName: string;
  companyName: string;
  raw: string;
  sections: DocSection[];
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Collapse a fragment to a single line with all markup removed. */
function inlineText(fragment: string): string {
  return decodeEntities(fragment.replace(TAG_RE, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * DART table cells are not just TD/TH:
 *   TD  static cell            TH  header cell
 *   TE  XBRL-tagged value      TU  form field value
 * The financial statement notes are almost entirely TE, and cover pages use TU,
 * so ignoring them drops every number while leaving the labels behind.
 *
 * The (?![\w-]) guards stop <TABLE> from matching <TABLE-GROUP>, which wraps
 * tables and would otherwise be parsed as one.
 */
const TABLE_RE = /<TABLE(?![\w-])[^>]*>([\s\S]*?)<\/TABLE\s*>/gi;
const ROW_RE = /<TR(?![\w-])[^>]*>([\s\S]*?)<\/TR\s*>/gi;
const CELL_RE = /<(T[DHEU])(?![\w-])[^>]*>([\s\S]*?)<\/\1\s*>/gi;

/**
 * Render a table as pipe-separated rows.
 * Cells are flattened first, otherwise their inner <P> tags split one row
 * across several lines. Nested tables are not expected in DART filings.
 */
function renderTable(inner: string): string {
  const rows: string[] = [];

  ROW_RE.lastIndex = 0;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = ROW_RE.exec(inner)) !== null) {
    const cells: string[] = [];

    CELL_RE.lastIndex = 0;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = CELL_RE.exec(rowMatch[1])) !== null) {
      cells.push(inlineText(cellMatch[2]));
    }

    if (cells.length > 0) rows.push(cells.join(" | "));
  }

  return rows.length > 0 ? `\n${rows.join("\n")}\n` : "";
}

/**
 * Strip markup from a document fragment and return readable text.
 * Table rows become pipe-separated lines so financial tables stay legible.
 */
export function extractText(fragment: string): string {
  let text = fragment;

  // Drop comments and processing instructions; unwrap CDATA
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<\?[\s\S]*?\?>/g, "");
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

  // Tables first: cells must be flattened before <P> turns into a line break
  text = text.replace(TABLE_RE, (_m, inner: string) => renderTable(inner));

  // Structure-bearing tags become line breaks before everything else is dropped
  text = text.replace(/<\/(TR|P|TITLE|SPAN-TITLE)\s*>/gi, "\n");
  text = text.replace(/<(BR|P)\s*\/?>/gi, "\n");
  text = text.replace(/<\/(SECTION-1|SECTION-2|SECTION-3|SECTION-4|PART)\s*>/gi, "\n\n");

  text = text.replace(TAG_RE, "");
  text = decodeEntities(text);

  return text
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readTagText(raw: string, openTagEnd: number, tagName: string): { text: string; end: number } {
  const closeRe = new RegExp(`</${tagName}\\s*>`, "i");
  const rest = raw.slice(openTagEnd);
  const match = rest.match(closeRe);
  if (!match || match.index === undefined) {
    return { text: "", end: openTagEnd };
  }
  return {
    text: inlineText(rest.slice(0, match.index)),
    end: openTagEnd + match.index + match[0].length,
  };
}

function readFirstTagText(raw: string, tagName: string): string {
  const openRe = new RegExp(`<${tagName}(\\s[^>]*)?>`, "i");
  const match = raw.match(openRe);
  if (!match || match.index === undefined) return "";
  return readTagText(raw, match.index + match[0].length, tagName).text;
}

/**
 * Build the section tree by scanning tags once, tracking structural depth.
 * A section runs until the next title at the same or shallower depth, so a
 * parent section naturally includes its children.
 */
export function parseDocument(xml: string): ParsedDocument {
  const sections: DocSection[] = [];
  const stack: string[] = [];

  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TAG_RE.exec(xml)) !== null) {
    const isClose = match[1] === "/";
    const name = match[2].toUpperCase();
    const selfClosing = match[4] === "/";

    if (name === "TITLE" && !isClose && !selfClosing) {
      const openTagEnd = match.index + match[0].length;
      const { text, end } = readTagText(xml, openTagEnd, "TITLE");
      if (text) {
        sections.push({
          index: sections.length + 1,
          depth: stack.length,
          title: text,
          titleStart: match.index,
          start: end,
          end: xml.length,
        });
      }
      TAG_RE.lastIndex = end > openTagEnd ? end : openTagEnd;
      continue;
    }

    if (!STRUCTURAL_TAGS.has(name) || selfClosing) continue;

    if (isClose) {
      const at = stack.lastIndexOf(name);
      if (at !== -1) stack.length = at;
    } else {
      stack.push(name);
    }
  }

  // A section ends where the next same-or-shallower title's tag begins, so the
  // next section's title text does not bleed into this one's body.
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      if (sections[j].depth <= sections[i].depth) {
        sections[i].end = sections[j].titleStart;
        break;
      }
    }
  }

  // Normalize away the DOCUMENT/BODY/LIBRARY wrapper depth so the TOC starts at 0
  const minDepth = sections.reduce((m, s) => Math.min(m, s.depth), Infinity);
  if (Number.isFinite(minDepth)) {
    for (const s of sections) s.depth -= minDepth;
  }

  return {
    docName: readFirstTagText(xml, "DOCUMENT-NAME"),
    companyName: readFirstTagText(xml, "COMPANY-NAME"),
    raw: xml,
    sections,
  };
}

/** Find a section by 1-based TOC index or by title keyword (case/space-insensitive). */
export function findSection(doc: ParsedDocument, query: string): DocSection | null {
  const q = query.trim();
  if (!q) return null;

  if (/^\d+$/.test(q)) {
    return doc.sections.find((s) => s.index === parseInt(q, 10)) ?? null;
  }

  const norm = (s: string) => s.toLowerCase().replace(/\s/g, "");
  const nq = norm(q);

  return (
    doc.sections.find((s) => norm(s.title) === nq) ??
    doc.sections.find((s) => norm(s.title).includes(nq)) ??
    null
  );
}

export function getSectionText(doc: ParsedDocument, section: DocSection): string {
  return extractText(doc.raw.slice(section.start, section.end));
}

export interface Truncated {
  text: string;
  truncated: boolean;
  totalChars: number;
}

export function truncate(text: string, maxChars: number): Truncated {
  const totalChars = text.length;
  if (totalChars <= maxChars) return { text, truncated: false, totalChars };
  return { text: text.slice(0, maxChars), truncated: true, totalChars };
}

export interface Page {
  text: string;
  totalChars: number;
  /** 0-based offset of the first character returned */
  start: number;
  /** exclusive offset of the last character returned */
  end: number;
  hasMore: boolean;
  /** offset was past the end of the text */
  beyondEnd: boolean;
}

/**
 * Window into a long section.
 *
 * Not every filing splits its notes into titled sections — 비나텍's 사업보고서
 * puts all 397k chars of them under one title, with the note headings as plain
 * paragraphs. Without paging, everything past the first window is unreachable.
 */
export function paginate(text: string, offset: number, maxChars: number): Page {
  const totalChars = text.length;
  const start = Math.min(Math.max(0, offset), totalChars);
  const end = Math.min(start + maxChars, totalChars);
  return {
    text: text.slice(start, end),
    totalChars,
    start,
    end,
    hasMore: end < totalChars,
    beyondEnd: offset > totalChars,
  };
}

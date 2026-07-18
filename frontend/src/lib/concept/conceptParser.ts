// Incremental parser: turn the streamed EXAONE text into concept-card events.
// Ported from Nodi-figma/lib/conceptParser.js, with the [art:key]/[svg] branches
// REMOVED (inline model illustrations are not a thing anymore) and
// made SYNCHRONOUS (Nodi streams tokens over SSE; per-char pacing, if wanted, is a
// separate queue layer). The event schema is 1:1 with the applyEvent reducer.
//
// Input format (enforced by exaone.CONCEPT_CARD_SYSTEM_PROMPT):
//   CHAT: ...                → chat bubble (reply-start + reply*chars)
//   @concept: title | cluster→ concept card start (cstart)
//   - body                   → body line (bstart{p} + delta*chars + bend)
//   @related: a, b           → related titles (related)
//   @end                     → concept end (cend)
//   **bold**  ==highlight==  → delta flags b / h (can overlap)

import type { ParserEvent } from "./types";

const CONCEPT_RE = /^@concept:\s*(.*)$/;
const RELATED_RE = /^@related:\s*(.*)$/;
const CHAT_PREFIX = "CHAT:"; // 채팅 버블 라인 접두사

export interface ConceptParser {
  push(text: string): void;
  end(): void;
}

export function createConceptParser(
  emit: (ev: ParserEvent) => void,
): ConceptParser {
  let line = ""; // current line buffer
  let inConcept = false; // between cstart..cend

  // Stream one body line as bstart / delta* / bend. **bold**(b) and
  // ==highlight==(h) toggle and may overlap. A lone `*` is dropped; a lone `=`
  // is emitted as a literal char (figma v1.1 behaviour).
  function emitBody(type: "p", body: string): void {
    emit({ t: "bstart", block: { type } });
    let bold = false;
    let star = false;
    let hi = false;
    let eq = false;
    const put = (ch: string) => emit({ t: "delta", ch, b: bold, h: hi });
    for (const ch of Array.from(body)) {
      if (ch === "*") {
        if (eq) {
          put("=");
          eq = false;
        }
        if (star) {
          bold = !bold;
          star = false;
        } else {
          star = true;
        }
        continue;
      }
      if (ch === "=") {
        if (star) star = false;
        if (eq) {
          hi = !hi;
          eq = false;
        } else {
          eq = true;
        }
        continue;
      }
      if (star) star = false;
      if (eq) {
        put("=");
        eq = false;
      }
      put(ch);
    }
    if (eq) put("=");
    emit({ t: "bend" });
  }

  function closeConcept(): void {
    if (!inConcept) return;
    inConcept = false;
    emit({ t: "cend" });
  }

  function flushLine(): void {
    const raw = line;
    line = "";
    const trimmed = raw.trim();
    if (trimmed === "") return;

    // chat line
    if (trimmed.startsWith(CHAT_PREFIX)) {
      emit({ t: "reply-start" });
      for (const ch of Array.from(trimmed.slice(CHAT_PREFIX.length).trim())) {
        emit({ t: "reply", ch });
      }
      return;
    }

    // concept start (auto-close a dangling concept)
    const cm = trimmed.match(CONCEPT_RE);
    if (cm) {
      closeConcept();
      const parts = cm[1].split("|").map((s) => s.trim());
      emit({
        t: "cstart",
        concept: { title: parts[0] ?? "", cluster: parts[1] ?? "" },
      });
      inConcept = true;
      return;
    }

    // concept end
    if (trimmed === "@end") {
      closeConcept();
      return;
    }

    // related concepts
    const rm = trimmed.match(RELATED_RE);
    if (rm) {
      const titles = rm[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (inConcept && titles.length) emit({ t: "related", titles });
      return;
    }

    // body line — only inside an open concept (silently skip before cstart)
    if (!inConcept) return;
    if (trimmed.startsWith("- ")) {
      emitBody("p", trimmed.slice(2).trim());
    }
    // unrecognised lines are silently skipped
  }

  return {
    // push a model token chunk (possibly many chars); flush on newline.
    push(text: string): void {
      for (const ch of Array.from(text)) {
        if (ch === "\n") flushLine();
        else line += ch;
      }
    },
    // end of stream: flush remaining line, close any open concept, emit done.
    end(): void {
      flushLine();
      closeConcept();
      emit({ t: "done" });
    },
  };
}

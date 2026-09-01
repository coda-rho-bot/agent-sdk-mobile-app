/**
 * Date-ordered store for conversation content learned over REST — the single
 * source of truth for EXTERNAL runs' transcript rows.
 *
 * Why this exists: the accumulator is a stream reconciler — it orders rows by
 * ARRIVAL, which is chronological only for a live stream. Feeding it polling
 * batches whose arrival order is scrambled by server-side message-index lag
 * (the runs endpoint is fresh, the messages endpoint lags writes by seconds to
 * tens of seconds) mis-orders rows: a user message can land after responses
 * that are chronologically later. This store keys records by message id and
 * orders by MESSAGE DATE, so display order is a property of the data, not of
 * when we happened to fetch it.
 *
 * The accumulator keeps its designed job: live local-stream reconciliation
 * and replay bookkeeping. External content renders from here instead.
 */
import type { TranscriptItem } from "./model";
import { cleanUserText, summarizeToolInput, formatToolInput } from "./toolText";

/** A single external message, normalized for ordering and rendering. */
interface ExternalRecord {
  id: string;
  /** Client lineage id — matches the sending session's echo for retirement. */
  otid?: string;
  date: string;
  kind: "user" | "assistant" | "reasoning" | "tool";
  text: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: string;
  toolIsError?: boolean;
}

/** Raw history record as returned by the messages endpoint. */
type RawMessage = {
  id?: string;
  date?: string;
  otid?: string;
  message_type?: string;
  content?: unknown;
  reasoning?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
  tool_call_id?: string;
  is_error?: boolean;
};

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content.length > 0 ? content : null;
  if (!Array.isArray(content)) return null;
  let out = "";
  for (const part of content) {
    if (typeof part === "string") out += part;
    else if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      out += (part as { text: string }).text;
    }
  }
  return out.length > 0 ? out : null;
}

export class ExternalTranscriptStore {
  private byId = new Map<string, ExternalRecord>();
  private sortedCache: ExternalRecord[] | null = null;
  /** Message ids (uuid) the store covers — fast membership for filtering. */
  private coveredIds = new Set<string>();

  /** Returns the number of records added or updated. */
  upsert(raw: readonly RawMessage[]): number {
    let changed = 0;
    for (const m of raw) {
      if (!m.id || !m.date || !m.message_type) continue;
      const rec = this.toRecord(m);
      if (!rec) continue;
      const existing = this.byId.get(rec.id);
      if (existing && existing.text === rec.text && existing.toolResult === rec.toolResult) continue;
      this.byId.set(rec.id, rec);
      this.coveredIds.add(rec.id);
      changed++;
    }
    if (changed > 0) this.sortedCache = null;
    return changed;
  }

  /** Records in chronological order. */
  rows(): readonly ExternalRecord[] {
    if (!this.sortedCache) {
      this.sortedCache = [...this.byId.values()].sort((a, b) =>
        a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1,
      );
    }
    return this.sortedCache;
  }

  /** Newest message date present (or null when empty) — echo anchor stamping. */
  maxDate(): string | null {
    const r = this.rows();
    return r.length ? (r[r.length - 1]!.date ?? null) : null;
  }

  /** Whether the store holds the message with this server id. */
  covers(messageId: string): boolean {
    return this.coveredIds.has(messageId);
  }

  /** Otids of stored user messages — echo retirement set. */
  userOtids(): Set<string> {
    const out = new Set<string>();
    for (const rec of this.byId.values()) {
      if (rec.kind === "user" && rec.otid) out.add(rec.otid);
    }
    return out;
  }

  clear(): void {
    this.byId.clear();
    this.coveredIds.clear();
    this.sortedCache = null;
  }

  private toRecord(m: RawMessage): ExternalRecord | null {
    switch (m.message_type) {
      case "user_message": {
        const text = textFromContent(m.content);
        if (text === null) return null;
        return { id: m.id!, otid: m.otid, date: m.date!, kind: "user", text: cleanUserText(text) };
      }
      case "assistant_message": {
        const text = textFromContent(m.content);
        if (text === null) return null;
        return { id: m.id!, date: m.date!, kind: "assistant", text };
      }
      case "reasoning_message": {
        const text =
          typeof m.reasoning === "string" ? m.reasoning : textFromContent(m.content);
        if (!text) return null;
        return { id: m.id!, date: m.date!, kind: "reasoning", text };
      }
      case "tool_call_message": {
        const call = m.tool_calls?.[0];
        if (!call?.id) return null;
        return {
          id: m.id!,
          date: m.date!,
          kind: "tool",
          text: "",
          toolCallId: call.id,
          toolName: call.function?.name ?? "tool",
          toolInput: call.function?.arguments,
        };
      }
      case "tool_result_message":
      case "tool_return_message": {
        // Tool results merge into their call's card by toolCallId; stored as
        // their own record so the merge in items() can pair them.
        const text = textFromContent(m.content);
        return {
          id: m.id!,
          date: m.date!,
          kind: "tool",
          text: "",
          toolCallId: m.tool_call_id ?? m.id!,
          toolResult: text ?? "",
          toolIsError: m.is_error === true,
        };
      }
      default:
        return null;
    }
  }

  /** Render-ready items in date order; tool results folded into their calls. */
  itemsWithDatesRev(): Array<{ date: string; item: TranscriptItem }> {
    const out: Array<{ date: string; item: TranscriptItem }> = [];
    const resultsByCall = new Map<string, { text: string; isError: boolean }>();
    for (const rec of this.rows()) {
      if (rec.kind === "tool" && rec.toolResult !== undefined && rec.toolCallId) {
        resultsByCall.set(rec.toolCallId, { text: rec.toolResult, isError: rec.toolIsError ?? false });
      }
    }
    for (const rec of this.rows()) {
      if (rec.kind === "user") {
        out.push({ date: rec.date, item: { kind: "user", id: rec.id, text: rec.text } });
      } else if (rec.kind === "assistant") {
        out.push({ date: rec.date, item: { kind: "assistant", id: rec.id, text: rec.text } });
      } else if (rec.kind === "reasoning") {
        out.push({ date: rec.date, item: { kind: "reasoning", id: rec.id, text: rec.text, seconds: 0 } });
      } else if (rec.kind === "tool") {
        // Bare results merge into their call card — not separate rows.
        if (rec.toolResult !== undefined) continue;
        const result = rec.toolCallId ? resultsByCall.get(rec.toolCallId) : undefined;
        out.push({
          date: rec.date,
          item: {
            kind: "tool",
            id: rec.id,
            toolCallId: rec.toolCallId ?? rec.id,
            name: rec.toolName ?? "tool",
            summary: summarizeToolInput(rec.toolInput),
            input: formatToolInput(rec.toolInput),
            status: result ? (result.isError ? "error" : "success") : "success",
            ...(result ? { result: result.text } : {}),
          },
        });
      }
    }
    return out;
  }
}
